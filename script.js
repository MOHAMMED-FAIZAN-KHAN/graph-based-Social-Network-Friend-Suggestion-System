'use strict';
/* ============================================================================
 * GRAPH SOCIAL â€” v2
 *
 * Frontend architecture (single bundle, module-per-concern):
 *   Storage        â†’ versioned, fault-tolerant persistence
 *   SocialGraph    â†’ adjacency-list graph: BFS, Dijkstra, analytics
 *   MinHeap        â†’ priority queue powering Dijkstra
 *   Recommender    â†’ Adamic-Adar + Jaccard + proximity scoring
 *   Api            â†’ async data layer (localStorage today, REST tomorrow)
 *   Views          â†’ pure render functions returning HTML strings
 *   NetworkView    â†’ force-directed interactive canvas
 *   DsaLab         â†’ stepped BFS / Dijkstra animation
 *
 * ---------------------------------------------------------------------------
 * BACKEND CONTRACT (drop-in replacement for the Api module)
 * ---------------------------------------------------------------------------
 * REST endpoints expected by `Api`:
 *   POST   /api/auth/register      { fullName, username, email, password, bio }
 *   POST   /api/auth/login         { identifier, password }        â†’ { token, user }
 *   POST   /api/auth/logout
 *   GET    /api/users/me
 *   GET    /api/users?q=&page=&size=
 *   GET    /api/users/{id}
 *   GET    /api/users/{id}/friends
 *   GET    /api/users/{id}/mutual/{otherId}
 *   GET    /api/users/{id}/suggestions?limit=
 *   GET    /api/graph/network?depth=
 *   POST   /api/friendships/requests        { toUserId }
 *   POST   /api/friendships/requests/{id}/accept
 *   POST   /api/friendships/requests/{id}/reject
 *   DELETE /api/friendships/{userId}
 *   GET    /api/graph/path?from=&to=&mode=bfs|dijkstra
 *
 * MySQL schema (InnoDB, utf8mb4_0900_ai_ci):
 *   users(id CHAR(36) PK, full_name VARCHAR(120), username VARCHAR(40) UNIQUE,
 *         email VARCHAR(190) UNIQUE, password_hash VARCHAR(100),
 *         bio VARCHAR(280), avatar_url VARCHAR(512),
 *         created_at TIMESTAMP, updated_at TIMESTAMP)
 *   friendships(user_a CHAR(36), user_b CHAR(36),
 *         PRIMARY KEY(user_a,user_b),
 *         CHECK (user_a < user_b),                       -- canonical ordering
 *         FOREIGN KEY(user_a) REFERENCES users(id) ON DELETE CASCADE,
 *         FOREIGN KEY(user_b) REFERENCES users(id) ON DELETE CASCADE,
 *         INDEX idx_b (user_b))
 *   friend_requests(id BIGINT PK AI, from_user CHAR(36), to_user CHAR(36),
 *         status ENUM('PENDING','REJECTED') DEFAULT 'PENDING',
 *         created_at TIMESTAMP,
 *         UNIQUE KEY uq_pair(from_user,to_user),
 *         FOREIGN KEY(from_user) REFERENCES users(id) ON DELETE CASCADE,
 *         FOREIGN KEY(to_user)   REFERENCES users(id) ON DELETE CASCADE)
 *   activity_log(id BIGINT PK AI, user_id CHAR(36), kind VARCHAR(40),
 *         payload JSON, created_at TIMESTAMP)
 *
 * Spring Boot layering: controller â†’ service â†’ repository (JPA) â†’ MySQL.
 * Security: BCryptPasswordEncoder, JWT or server sessions (HttpOnly cookie),
 *           stateless filter chain, rate limiting on /api/auth/**.
 * Note: friendship is a symmetric relation, so store it once with a<b and
 *       query both columns (or use a VIEW) â€” never store both directions.
 * ========================================================================== */

/* ============================================================================
 * CONFIG
 * ========================================================================== */
const CONFIG = Object.freeze({
  STORAGE_VERSION: 4,
  DEMO_PASSWORD: 'demo123',
  SUGGESTION_LIMIT: 24,
  MAX_TRAVERSAL_DEPTH: 4,
  MIN_PASSWORD_LENGTH: 6,
  WEIGHTS: Object.freeze({ mutual: 0.50, jaccard: 0.20, proximity: 0.15, popularity: 0.15 }),
});

/* ============================================================================
 * STORAGE â€” versioned, fault-tolerant (handles private mode / quota errors)
 * ========================================================================== */
const Storage = (() => {
  const available = (() => {
    try {
      const probe = '__gsn_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch { return false; }
  })();

  const memory = new Map();

  return {
    available,
    KEYS: Object.freeze({
      VERSION: 'gsn_version',
      USERS: 'gsn_users',
      FRIENDSHIPS: 'gsn_friendships',
      REQUESTS: 'gsn_requests',
      REJECTED: 'gsn_rejected',
      CURRENT_USER: 'gsn_currentUser',
      THEME: 'gsn_theme',
      ACTIVITY: 'gsn_activity',
    }),

    get(key, fallback = null) {
      try {
        const raw = available ? localStorage.getItem(key) : memory.get(key) ?? null;
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch (err) {
        console.warn('[Storage] Failed to read', key, err);
        return fallback;
      }
    },

    set(key, value) {
      try {
        const raw = JSON.stringify(value);
        if (available) localStorage.setItem(key, raw);
        else memory.set(key, raw);
        return true;
      } catch (err) {
        console.error('[Storage] Failed to write', key, err);
        // Quota exceeded â†’ degrade to in-memory so the session keeps working.
        try { memory.set(key, JSON.stringify(value)); } catch { /* give up */ }
        return false;
      }
    },

    remove(key) {
      try { if (available) localStorage.removeItem(key); memory.delete(key); } catch { /* noop */ }
    },

    resetAll() {
      Object.values(this.KEYS).forEach((k) => this.remove(k));
      memory.clear();
    },
  };
})();

/* ============================================================================
 * ERRORS
 * ========================================================================== */
class GraphError extends Error {
  constructor(message, code = 'GRAPH_ERROR') {
    super(message);
    this.name = 'GraphError';
    this.code = code;
  }
}
class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/* ============================================================================
 * MIN-HEAP â€” priority queue for Dijkstra  (O(log n) push/pop)
 * ========================================================================== */
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].dist <= this.items[i].dist) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  pop() {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l].dist < this.items[smallest].dist) smallest = l;
        if (r < this.items.length && this.items[r].dist < this.items[smallest].dist) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/* ============================================================================
 * SOCIAL GRAPH â€” undirected, weighted, adjacency-list
 * ========================================================================== */
class SocialGraph {
  constructor() {
    /** @type {Map<string, Set<string>>} */
    this.adjacency = new Map();
  }

  /* ---------- mutation ---------- */
  hasUser(id) { return this.adjacency.has(id); }

  addUser(id) {
    if (!id || typeof id !== 'string') throw new GraphError('addUser: a non-empty string id is required', 'INVALID_ID');
    if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
    return this;
  }

  removeUser(id) {
    const friends = this.adjacency.get(id);
    if (!friends) return this;
    for (const friendId of friends) this.adjacency.get(friendId)?.delete(id);
    this.adjacency.delete(id);
    return this;
  }

  addEdge(a, b) {
    if (!a || !b) throw new GraphError('addEdge: both endpoints are required', 'INVALID_ENDPOINT');
    if (a === b) throw new GraphError('addEdge: self-loops are not allowed', 'SELF_LOOP');
    this.addUser(a).addUser(b);
    this.adjacency.get(a).add(b);
    this.adjacency.get(b).add(a);
    return this;
  }

  removeEdge(a, b) {
    this.adjacency.get(a)?.delete(b);
    this.adjacency.get(b)?.delete(a);
    return this;
  }

  /* ---------- queries ---------- */
  areFriends(a, b) { return this.adjacency.get(a)?.has(b) ?? false; }
  getFriends(id) { return Array.from(this.adjacency.get(id) ?? []); }
  degree(id) { return this.adjacency.get(id)?.size ?? 0; }
  getAllUsers() { return Array.from(this.adjacency.keys()); }
  getUserCount() { return this.adjacency.size; }

  getEdgeCount() {
    let total = 0;
    for (const friends of this.adjacency.values()) total += friends.size;
    return total / 2;
  }

  /** Mutual friends between a and b. Symmetric; O(min(deg a, deg b)). */
  getMutualFriends(a, b) {
    if (a === b) return [];
    const setA = this.adjacency.get(a);
    const setB = this.adjacency.get(b);
    if (!setA || !setB) return [];
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    const out = [];
    for (const id of small) if (large.has(id)) out.push(id);
    return out;
  }

  /**
   * Traversal cost between two directly-connected users.
   * Cost âˆˆ (1, 3]: a weak tie (0 mutual friends) costs 3, a very strong tie
   * approaches 1. This lets Dijkstra prefer a strong 2-hop chain over a single
   * weak 1-hop link â€” which is exactly the difference from BFS.
   */
  edgeCost(a, b) {
    if (!this.areFriends(a, b)) return Infinity;
    const mutual = this.getMutualFriends(a, b).length;
    return 1 + 2 / (1 + mutual);
  }

  /* ---------- BFS ---------- */
  /**
   * Breadth-first search. Returns Map<userId, distance>.
   * @throws {GraphError} if the start node does not exist.
   */
  bfs(startId) {
    if (!this.adjacency.has(startId)) {
      throw new GraphError(`BFS: unknown start node "${startId}"`, 'UNKNOWN_NODE');
    }
    const distances = new Map([[startId, 0]]);
    const queue = [startId];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const nextDist = distances.get(current) + 1;
      for (const neighbour of this.adjacency.get(current)) {
        if (!distances.has(neighbour)) {
          distances.set(neighbour, nextDist);
          queue.push(neighbour);
        }
      }
    }
    return distances;
  }

  /** Fewest-hops path via BFS. Returns { path, hops } or null. */
  bfsShortestPath(startId, endId) {
    if (!this.adjacency.has(startId)) throw new GraphError(`Unknown start node "${startId}"`, 'UNKNOWN_NODE');
    if (!this.adjacency.has(endId)) throw new GraphError(`Unknown end node "${endId}"`, 'UNKNOWN_NODE');
    if (startId === endId) return { path: [startId], hops: 0 };

    const parent = new Map();
    const visited = new Set([startId]);
    const queue = [startId];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      for (const neighbour of this.adjacency.get(current)) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        parent.set(neighbour, current);
        if (neighbour === endId) {
          const path = [];
          let node = endId;
          while (node !== undefined) { path.unshift(node); node = parent.get(node); }
          return { path, hops: path.length - 1 };
        }
        queue.push(neighbour);
      }
    }
    return null;
  }

  /* ---------- Dijkstra ---------- */
  /**
   * Weighted single-source shortest paths.
   * @returns {{dist:Map<string,number>, prev:Map<string,string>,
   *            order:string[], relaxations:Array}}
   */
  dijkstra(startId) {
    if (!this.adjacency.has(startId)) {
      throw new GraphError(`Dijkstra: unknown start node "${startId}"`, 'UNKNOWN_NODE');
    }
    const dist = new Map();
    const prev = new Map();
    const settled = new Set();
    const order = [];
    const relaxations = [];
    const heap = new MinHeap();

    for (const id of this.adjacency.keys()) dist.set(id, Infinity);
    dist.set(startId, 0);
    heap.push({ id: startId, dist: 0 });

    while (heap.size > 0) {
      const top = heap.pop();
      if (!top || settled.has(top.id)) continue;   // stale heap entry
      settled.add(top.id);
      order.push(top.id);

      const baseDist = dist.get(top.id);
      for (const neighbour of this.adjacency.get(top.id)) {
        if (settled.has(neighbour)) continue;
        const weight = this.edgeCost(top.id, neighbour);
        if (!Number.isFinite(weight)) continue;
        const candidate = baseDist + weight;
        if (candidate < dist.get(neighbour) - 1e-9) {
          dist.set(neighbour, candidate);
          prev.set(neighbour, top.id);
          heap.push({ id: neighbour, dist: candidate });
          relaxations.push({ from: top.id, to: neighbour, dist: candidate });
        }
      }
    }
    return { dist, prev, order, relaxations };
  }

  /**
   * Strongest-connection path via Dijkstra.
   * @returns {{path:string[], cost:number, hops:number}|null}
   */
  dijkstraPath(startId, endId) {
    const { dist, prev } = this.dijkstra(startId);
    if (!dist.has(endId) || !Number.isFinite(dist.get(endId))) return null;
    const path = [];
    let node = endId;
    let guard = 0;
    while (node !== undefined && guard++ < this.adjacency.size + 1) {
      path.unshift(node);
      if (node === startId) break;
      node = prev.get(node);
    }
    if (path[0] !== startId) return null;
    return { path, cost: dist.get(endId), hops: path.length - 1 };
  }

  /* ---------- analytics ---------- */
  connectedComponents() {
    const seen = new Set();
    const components = [];
    for (const id of this.adjacency.keys()) {
      if (seen.has(id)) continue;
      const component = [];
      const queue = [id];
      seen.add(id);
      let head = 0;
      while (head < queue.length) {
        const current = queue[head++];
        component.push(current);
        for (const neighbour of this.adjacency.get(current)) {
          if (!seen.has(neighbour)) { seen.add(neighbour); queue.push(neighbour); }
        }
      }
      components.push(component);
    }
    return components;
  }

  /** Exact diameter (max finite BFS distance). Fine for small graphs. */
  diameter() {
    let best = 0;
    for (const id of this.adjacency.keys()) {
      const distances = this.bfs(id);
      for (const d of distances.values()) if (d > best) best = d;
    }
    return best;
  }

  /** Average local clustering coefficient. */
  clusteringCoefficient() {
    let total = 0;
    let counted = 0;
    for (const id of this.adjacency.keys()) {
      const friends = this.getFriends(id);
      const k = friends.length;
      if (k < 2) continue;
      let links = 0;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          if (this.areFriends(friends[i], friends[j])) links++;
        }
      }
      total += (2 * links) / (k * (k - 1));
      counted++;
    }
    return counted === 0 ? 0 : total / counted;
  }

  getAnalytics() {
    const n = this.getUserCount();
    const edges = this.getEdgeCount();
    const possible = n > 1 ? (n * (n - 1)) / 2 : 0;
    const degrees = this.getAllUsers().map((id) => ({ id, degree: this.degree(id) }));
    degrees.sort((a, b) => b.degree - a.degree);

    return {
      users: n,
      edges,
      density: possible > 0 ? edges / possible : 0,
      avgDegree: n > 0 ? (edges * 2) / n : 0,
      maxDegree: degrees[0]?.degree ?? 0,
      components: this.connectedComponents().length,
      diameter: n > 0 ? this.diameter() : 0,
      clustering: this.clusteringCoefficient(),
      hubs: degrees.slice(0, 5),
    };
  }
}

/* ============================================================================
 * RECOMMENDATION ENGINE
 * score = 0.50Â·AdamicAdar + 0.20Â·Jaccard + 0.15Â·Proximity + 0.15Â·Popularity
 * ========================================================================== */
class RecommendationEngine {
  constructor(graph, users, requests = [], rejected = []) {
    this.graph = graph;
    this.users = users;
    this.requests = requests;
    this.rejected = rejected;
    this._userIndex = new Map(users.map((u) => [u.id, u]));
    this._maxDegree = Math.max(1, ...graph.getAllUsers().map((id) => graph.degree(id)));
  }

  _isRejected(a, b) {
    const key = [a, b].sort().join('|');
    return this.rejected.includes(key);
  }

  /** Users that must never be suggested to `userId`. */
  _buildExclusions(userId) {
    const excluded = new Set([userId]);
    for (const friend of this.graph.getFriends(userId)) excluded.add(friend);
    for (const req of this.requests) {
      if (req.from === userId) excluded.add(req.to);
      if (req.to === userId) excluded.add(req.from);
    }
    for (const key of this.rejected) {
      const [a, b] = key.split('|');
      if (a === userId) excluded.add(b);
      if (b === userId) excluded.add(a);
    }
    return excluded;
  }

  /**
   * Score a single candidate. Returns null when the candidate is not eligible.
   */
  scoreCandidate(userId, candidateId, distance) {
    const mutual = this.graph.getMutualFriends(userId, candidateId);
    if (mutual.length === 0) return null;

    // Adamicâ€“Adar: rare shared neighbours matter more than popular ones.
    let adamicAdar = 0;
    for (const mutualId of mutual) {
      const degree = Math.max(this.graph.degree(mutualId), 2);
      adamicAdar += 1 / Math.log(degree);
    }
    const aaNormalised = adamicAdar / (1 + adamicAdar); // squash into [0,1)

    // Jaccard similarity of neighbourhoods.
    const friendsA = new Set(this.graph.getFriends(userId));
    const friendsB = new Set(this.graph.getFriends(candidateId));
    const union = new Set([...friendsA, ...friendsB]);
    const jaccard = union.size > 0 ? mutual.length / union.size : 0;

    // Proximity: closer = better. Unreachable nodes get the floor value.
    const safeDistance = Number.isFinite(distance) ? distance : CONFIG.MAX_TRAVERSAL_DEPTH + 1;
    const proximity = 1 / (1 + Math.max(0, safeDistance - 1));

    // Popularity (log-damped degree), so hubs surface but don't dominate.
    const popularity = Math.log(1 + this.graph.degree(candidateId)) / Math.log(1 + this._maxDegree);

    const W = CONFIG.WEIGHTS;
    const score =
      W.mutual * aaNormalised +
      W.jaccard * jaccard +
      W.proximity * proximity +
      W.popularity * popularity;

    const reasons = [];
    reasons.push(`${mutual.length} mutual friend${mutual.length === 1 ? '' : 's'}`);
    if (Number.isFinite(distance)) reasons.push(`${distance} hop${distance === 1 ? '' : 's'} away`);
    if (popularity > 0.75) reasons.push('well connected');

    return {
      user: this._userIndex.get(candidateId),
      score,
      mutualCount: mutual.length,
      mutualFriends: mutual.map((id) => this._userIndex.get(id)).filter(Boolean),
      distance: safeDistance,
      reasons,
      breakdown: { adamicAdar: aaNormalised, jaccard, proximity, popularity },
    };
  }

  /** Ranked suggestions, best first. Never throws â€” returns [] on bad input. */
  getSuggestions(userId, limit = CONFIG.SUGGESTION_LIMIT) {
    if (!userId || !this.graph.hasUser(userId)) return [];

    let distances;
    try {
      distances = this.graph.bfs(userId);
    } catch (err) {
      console.warn('[Recommender] BFS failed, falling back to direct scan', err);
      distances = new Map([[userId, 0]]);
    }

    const excluded = this._buildExclusions(userId);
    const scored = [];

    for (const candidateId of this.graph.getAllUsers()) {
      if (excluded.has(candidateId)) continue;
      const distance = distances.has(candidateId) ? distances.get(candidateId) : Infinity;
      // Only consider nodes within the traversal horizon.
      if (Number.isFinite(distance) && distance > CONFIG.MAX_TRAVERSAL_DEPTH) continue;
      const result = this.scoreCandidate(userId, candidateId, distance);
      if (result) scored.push(result);
    }

    scored.sort((a, b) => b.score - a.score || b.mutualCount - a.mutualCount);
    return scored.slice(0, limit);
  }
}

/* ============================================================================
 * API LAYER â€” async faÃ§ade over persistence.
 * Swap the bodies for `fetch()` calls to go full REST with zero UI changes.
 * ========================================================================== */
const Api = {
  async loadSession() {
    const version = Storage.get(Storage.KEYS.VERSION, 0);
    const users = Storage.get(Storage.KEYS.USERS);
    const needsSeed = !Array.isArray(users) || users.length === 0 || version !== CONFIG.STORAGE_VERSION;

    if (needsSeed) {
      Storage.resetAll();
      Storage.set(Storage.KEYS.VERSION, CONFIG.STORAGE_VERSION);
      return {
        users: structuredClone(DEMO_USERS),
        friendships: structuredClone(DEMO_FRIENDSHIPS),
        requests: [],
        rejected: [],
        currentUserId: null,
        seeded: true,
      };
    }

    return {
      users: users.map(normalizeUser),
      friendships: Storage.get(Storage.KEYS.FRIENDSHIPS, DEMO_FRIENDSHIPS),
      requests: Storage.get(Storage.KEYS.REQUESTS, []),
      rejected: Storage.get(Storage.KEYS.REJECTED, []),
      currentUserId: Storage.get(Storage.KEYS.CURRENT_USER, null),
      seeded: false,
    };
  },

  async persist(state) {
    Storage.set(Storage.KEYS.VERSION, CONFIG.STORAGE_VERSION);
    Storage.set(Storage.KEYS.USERS, state.users);
    Storage.set(Storage.KEYS.REQUESTS, state.requests);
    Storage.set(Storage.KEYS.REJECTED, state.rejected);
    Storage.set(Storage.KEYS.CURRENT_USER, state.currentUser ? state.currentUser.id : null);
    Storage.set(Storage.KEYS.FRIENDSHIPS, extractFriendships(state.graph));
  },

  async reset() { Storage.resetAll(); },
};

/* ============================================================================
 * DEMO DATA
 * ========================================================================== */
const DEMO_USERS = [
  { id: 'u1',  fullName: 'Faizan Khan',  username: 'faizan',  email: 'faizan@demo.com',  password: 'demo123', bio: 'CS student & team leader.',  avatar: '' },
  { id: 'u2',  fullName: 'Kaushik',      username: 'kaushik', email: 'kaushik@demo.com', password: 'demo123', bio: 'Frontend developer.',             avatar: '' },
  { id: 'u3',  fullName: 'Arya',         username: 'arya',    email: 'arya@demo.com',    password: 'demo123', bio: 'Backend engineer.',               avatar: '' },
  { id: 'u4',  fullName: 'Animesh',      username: 'animesh', email: 'animesh@demo.com', password: 'demo123', bio: 'Data science student.',           avatar: '' },
  { id: 'u5',  fullName: 'arhaam',       username: 'arhaam',  email: 'arhaam@demo.com',  password: 'demo123', bio: 'UI/UX designer.',                 avatar: '' },
  { id: 'u6',  fullName: 'Armaan Sheikh',username: 'armaan',  email: 'armaan@demo.com',  password: 'demo123', bio: 'Mobile app developer.',           avatar: '' },
  { id: 'u7',  fullName: 'Zaid Hussain', username: 'zaid',    email: 'zaid@demo.com',    password: 'demo123', bio: 'Cloud architect.',                avatar: '' },
  { id: 'u8',  fullName: 'Ayaan Malik',  username: 'ayaan',   email: 'ayaan@demo.com',   password: 'demo123', bio: 'Game developer.',                 avatar: '' },
  { id: 'u9',  fullName: 'rajiv talwar', username: 'rajiv talwar',   email: 'rajiv talwar@demo.com',   password: 'demo123', bio: 'DevOps engineer.',                avatar: '' },
  { id: 'u10', fullName: 'modi_paglu',   username: 'modi_paglu',   email: 'modi_paglu@demo.com',   password: 'demo123', bio: 'AI/ML enthusiast.',               avatar: '' },
];

const DEMO_FRIENDSHIPS = [
  ['u1','u2'], ['u1','u3'], ['u2','u4'], ['u3','u4'], ['u2','u5'],
  ['u4','u5'], ['u3','u6'], ['u5','u7'], ['u6','u7'], ['u7','u8'],
  ['u8','u9'], ['u9','u10'], ['u1','u6'], ['u4','u8'], ['u5','u9'],
];

/* ============================================================================
 * STATE
 * ========================================================================== */
const state = {
  users: [],
  graph: new SocialGraph(),
  requests: [],
  rejected: [],
  currentUser: null,
  theme: 'light',
  recommendations: [],
  view: 'login',
  selectedProfile: null,
  searchQuery: '',
  loading: true,
  fatalError: null,
};

let recEngine = null;
let renderToken = 0;      // guards against stale async renders

/* ============================================================================
 * HELPERS
 * ========================================================================== */
function normalizeUser(user) {
  return {
    id: String(user.id ?? `u${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    fullName: String(user.fullName ?? 'Unnamed User').trim() || 'Unnamed User',
    username: String(user.username ?? 'user').trim().toLowerCase(),
    email: String(user.email ?? '').trim().toLowerCase(),
    password: String(user.password ?? ''),
    bio: String(user.bio ?? 'Hello! I am new here.').trim(),
    avatar: String(user.avatar ?? '').trim(),
  };
}

function getUserById(id) { return state.users.find((u) => u.id === id) ?? null; }
function getUserName(id) { return getUserById(id)?.fullName ?? id; }

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getInitials(name) {
  const parts = String(name ?? '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderAvatar(user, size = '') {
  if (!user) return `<div class="avatar ${size}" aria-hidden="true">?</div>`;
  const cls = `avatar ${size}`.trim();
  const initials = escapeHTML(getInitials(user.fullName));
  const alt = escapeHTML(user.fullName);
  if (user.avatar) {
    return `<img src="${escapeHTML(user.avatar)}" alt="${alt}" class="${cls}"
      onerror="this.style.display='none';this.nextElementSibling.style.display='grid';" />
      <div class="${cls}" style="display:none" aria-hidden="true">${initials}</div>`;
  }
  return `<div class="${cls}" aria-hidden="true">${initials}</div>`;
}

function extractFriendships(graph) {
  const friendships = [];
  const seen = new Set();
  for (const [userId, friends] of graph.adjacency) {
    for (const friendId of friends) {
      const key = [userId, friendId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      friendships.push([userId, friendId]);
    }
  }
  return friendships;
}

function formatNumber(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ============================================================================
 * TOASTS
 * ========================================================================== */
const TOAST_ICONS = { success: 'âœ“', error: 'âœ•', warning: 'âš ', info: 'â„¹' };

function showToast(message, type = 'info', duration = 3200) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type] ?? 'â„¹'}</span><span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);

  const remove = () => {
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };
  setTimeout(remove, duration);
}

/* ============================================================================
 * DOM / THEME
 * ========================================================================== */
function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  Storage.set(Storage.KEYS.THEME, state.theme);
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  render();
}

/* ============================================================================
 * BOOTSTRAP
 * ========================================================================== */
async function initApp() {
  applyTheme(Storage.get(Storage.KEYS.THEME, 'light'));
  render(); // paint skeleton immediately

  try {
    const session = await Api.loadSession();

    state.users = session.users.map(normalizeUser);
    state.requests = Array.isArray(session.requests) ? session.requests : [];
    state.rejected = Array.isArray(session.rejected) ? session.rejected : [];
    rebuildGraph(session.friendships);

    state.currentUser = session.currentUserId
      ? state.users.find((u) => u.id === session.currentUserId) ?? null
      : null;

    if (session.seeded) await Api.persist(state);

    if (state.currentUser) {
      state.view = 'dashboard';
      refreshRecommendations();
    } else {
      state.view = 'login';
    }
  } catch (err) {
    console.error('[initApp]', err);
    state.fatalError = err;
  } finally {
    state.loading = false;
    render();
  }
}

function rebuildGraph(friendshipList) {
  const graph = new SocialGraph();
  for (const user of state.users) graph.addUser(user.id);

  if (Array.isArray(friendshipList)) {
    for (const entry of friendshipList) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [a, b] = entry;
      if (!graph.hasUser(a) || !graph.hasUser(b) || a === b) continue;
      graph.addEdge(a, b);
    }
  }
  state.graph = graph;
}

function refreshRecommendations() {
  if (!state.currentUser) { state.recommendations = []; return; }
  try {
    recEngine = new RecommendationEngine(state.graph, state.users, state.requests, state.rejected);
    state.recommendations = recEngine.getSuggestions(state.currentUser.id);
  } catch (err) {
    console.error('[refreshRecommendations]', err);
    state.recommendations = [];
  }
}

async function persistAndRefresh() {
  try { await Api.persist(state); }
  catch (err) { console.error('[persist]', err); showToast('Changes could not be saved locally.', 'warning'); }
  refreshRecommendations();
  render();
}

/* ============================================================================
 * AUTH SERVICE
 * ========================================================================== */
function validateRegistration(data) {
  const errors = [];
  if (!data.fullName || data.fullName.trim().length < 2) errors.push({ field: 'regName', message: 'Full name must be at least 2 characters.' });
  if (!/^[a-z0-9_.]{3,30}$/i.test(data.username)) errors.push({ field: 'regUsername', message: 'Username must be 3â€“30 characters (letters, numbers, _ or .).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push({ field: 'regEmail', message: 'Please enter a valid email address.' });
  if (!data.password || data.password.length < CONFIG.MIN_PASSWORD_LENGTH) errors.push({ field: 'regPassword', message: `Password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters.` });
  return errors;
}

function login(identifier, password) {
  const id = String(identifier ?? '').trim().toLowerCase();
  if (!id || !password) return { success: false, message: 'Please fill in all fields.' };

  const user = state.users.find(
    (u) => (u.email === id || u.username === id) && u.password === password
  );
  if (!user) return { success: false, message: 'Invalid email/username or password.' };

  state.currentUser = user;
  state.view = 'dashboard';
  Storage.set(Storage.KEYS.CURRENT_USER, user.id);
  refreshRecommendations();
  render();
  showToast(`Welcome back, ${user.fullName.split(' ')[0]}!`, 'success');
  return { success: true };
}

function register(data) {
  const errors = validateRegistration(data);
  if (errors.length > 0) return { success: false, errors };

  const username = data.username.trim().toLowerCase();
  const email = data.email.trim().toLowerCase();

  if (state.users.some((u) => u.username === username)) {
    return { success: false, errors: [{ field: 'regUsername', message: 'That username is already taken.' }] };
  }
  if (state.users.some((u) => u.email === email)) {
    return { success: false, errors: [{ field: 'regEmail', message: 'That email is already registered.' }] };
  }

  const newUser = normalizeUser({
    id: `u${Date.now().toString(36)}`,
    fullName: data.fullName,
    username,
    email,
    password: data.password,
    bio: data.bio || 'Hello! I am new here.',
    avatar: data.avatar || '',
  });

  state.users.push(newUser);
  state.graph.addUser(newUser.id);
  state.currentUser = newUser;
  state.view = 'dashboard';
  persistAndRefresh();
  showToast('Account created. Welcome aboard!', 'success');
  return { success: true };
}

function logout() {
  state.currentUser = null;
  state.view = 'login';
  state.selectedProfile = null;
  state.recommendations = [];
  Storage.remove(Storage.KEYS.CURRENT_USER);
  render();
  showToast('Signed out.', 'info');
}

/* ============================================================================
 * FRIEND SERVICE
 * ========================================================================== */
function sendFriendRequest(targetId) {
  const current = state.currentUser;
  if (!current) return;

  const target = getUserById(targetId);
  if (!target) return showToast('That user is no longer available.', 'error');
  if (targetId === current.id) return showToast('You cannot send a request to yourself.', 'error');
  if (state.graph.areFriends(current.id, targetId)) return showToast('You are already friends.', 'warning');
  if (state.requests.some((r) => r.from === current.id && r.to === targetId)) return showToast('Request already sent.', 'warning');
  if (state.requests.some((r) => r.from === targetId && r.to === current.id)) return showToast('They already sent you a request â€” check your requests.', 'warning');

  const rejectKey = [current.id, targetId].sort().join('|');
  if (state.rejected.includes(rejectKey)) return showToast('A previous request was rejected. You cannot re-send.', 'error');

  state.requests.push({ from: current.id, to: targetId, timestamp: Date.now() });
  persistAndRefresh();
  showToast(`Friend request sent to ${target.fullName}.`, 'success');
}

function acceptRequest(requestIndex) {
  const req = state.requests[requestIndex];
  if (!req) return showToast('That request no longer exists.', 'error');

  try {
    state.graph.addEdge(req.from, req.to);
  } catch (err) {
    console.error('[acceptRequest]', err);
    return showToast('Could not create that friendship.', 'error');
  }

  state.requests.splice(requestIndex, 1);
  persistAndRefresh();
  showToast(`You are now friends with ${getUserName(req.from)}!`, 'success');
}

function rejectRequest(requestIndex) {
  const req = state.requests[requestIndex];
  if (!req) return showToast('That request no longer exists.', 'error');

  state.rejected.push([req.from, req.to].sort().join('|'));
  state.requests.splice(requestIndex, 1);
  persistAndRefresh();
  showToast('Request declined.', 'warning');
}

function removeFriend(friendId) {
  const current = state.currentUser;
  if (!current || !state.graph.areFriends(current.id, friendId)) return;
  state.graph.removeEdge(current.id, friendId);
  persistAndRefresh();
  showToast(`Removed ${getUserName(friendId)} from your friends.`, 'warning');
}

/* ============================================================================
 * NAVIGATION
 * ========================================================================== */
function navigate(view, extra = {}) {
  state.view = view;
  if (extra.profileId !== undefined) state.selectedProfile = extra.profileId;
  if (extra.resetProfile) state.selectedProfile = null;
  closeDrawer();
  render();
  const main = document.getElementById('mainContent');
  if (main) main.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function openDrawer() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('scrim')?.classList.add('open');
}
function closeDrawer() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('scrim')?.classList.remove('open');
}

/* ============================================================================
 * SKELETON
 * ========================================================================== */
function renderSkeleton() {
  return `
    <div class="app">
      <header class="topbar">
        <div class="logo">
          ${LOGO_SVG}
          <span>Graph Social</span>
        </div>
      </header>
      <div class="content">
        <div class="skeleton sk-line" style="width:220px;height:26px;"></div>
        <div class="skeleton sk-line" style="width:340px;"></div>
        <div class="stats-grid" style="margin-top:24px;">
          ${Array.from({ length: 4 }).map(() => '<div class="skeleton sk-card"></div>').join('')}
        </div>
        <div class="user-grid">
          ${Array.from({ length: 6 }).map(() => '<div class="skeleton sk-card"></div>').join('')}
        </div>
      </div>
    </div>`;
}

/* ============================================================================
 * RENDER ENGINE
 * ========================================================================== */
const LOGO_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/>
    <circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>
    <line x1="9" y1="9" x2="7" y2="7"/><line x1="15" y1="9" x2="17" y2="7"/>
    <line x1="9" y1="15" x2="7" y2="17"/><line x1="15" y1="15" x2="17" y2="17"/>
  </svg>`;

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  renderToken++;
  AuthEffects.destroy();
  NetworkView.destroy();
  DsaLab.destroy();

  try {
    document.body.classList.toggle('auth-active', state.loading || state.view === 'login' || state.view === 'register');

    if (state.fatalError) {
      app.innerHTML = renderFatalError(state.fatalError);
      return;
    }
    if (state.loading) {
      app.innerHTML = renderSkeleton();
      return;
    }
    if (state.view === 'login') {
      app.innerHTML = renderLogin();
      bindLogin();
      return;
    }
    if (state.view === 'register') {
      app.innerHTML = renderRegister();
      bindRegister();
      return;
    }
    app.innerHTML = renderAppShell();
    bindApp();

    if (state.view === 'network') {
      requestAnimationFrame(() => NetworkView.mount(document.getElementById('networkCanvas')));
    }
    if (state.view === 'dsa') {
      requestAnimationFrame(() => DsaLab.mount(document.getElementById('dsaCanvas')));
    }
  } catch (err) {
    console.error('[render]', err);
    app.innerHTML = renderFatalError(err);
  }
}

function renderFatalError(err) {
  return `
    <div class="error-panel">
      <h2>Something went wrong</h2>
      <p class="muted">The interface hit an unexpected error. Your data is safe â€” reload to continue.</p>
      <pre>${escapeHTML(err?.message ?? String(err))}</pre>
      <button class="btn btn-primary mt-16" onclick="location.reload()">Reload application</button>
    </div>`;
}

/* ============================================================================
 * LOGIN VIEW
 * ========================================================================== */
const DEMO_PW = 'demo123';
const USERS = {
  faizan: 'faizan@demo.com',
  kaushik: 'kaushik@demo.com',
  arya: 'arya@demo.com',
  animesh: 'animesh@demo.com'
};

function renderLogin() {
  const demoUsers = state.users.filter((u) => USERS[u.username]).slice(0, 4);
  return `
    <div class="login-wrap">
      <div class="auth-container" id="authContainer">
        <aside class="auth-showcase" aria-hidden="true">
          <div class="showcase-glow"></div>
          <div class="brand-mark"><span class="brand-dot"></span><span>Graph Social</span></div>
          <div class="showcase-copy">
            <div class="eyebrow">Your network, visualized</div>
            <h1>Relationships are easier to understand when you can see them.</h1>
            <p>Build meaningful connections, discover mutual friends, and explore your social graph in real time.</p>
          </div>
          <div class="network-canvas-wrap">
            <canvas id="loginNetworkCanvas" aria-hidden="true"></canvas>
          </div>
          <div class="auth-proof"><strong>${state.users.length || DEMO_USERS.length}</strong><span>demo profiles ready to explore</span></div>
        </aside>

        <main class="auth-card">
          <div class="logo-icon">${LOGO_SVG}</div>
          <h2>Welcome back</h2>
          <p class="auth-subtitle">Sign in to continue exploring your network.</p>

          <div class="form-group">
            <label for="loginId">Email or username</label>
            <input type="text" class="form-control" id="loginId" value="faizan" placeholder="faizan or faizan@demo.com" autocomplete="username" />
          </div>
          <div class="form-group">
            <label for="loginPw">Password</label>
            <input type="password" class="form-control" id="loginPw" value="demo123" placeholder="demo123" autocomplete="current-password" />
          </div>
          <div id="loginError" hidden class="form-error" role="alert"></div>
          <button type="button" class="btn btn-primary btn-block" id="loginBtn">Sign in →</button>

          <div class="auth-divider"><span>or use a demo profile</span></div>
          <div class="demo-grid">
            ${demoUsers.map((u) => `
              <button type="button" class="demo-btn" data-u="${escapeHTML(u.username)}">
                ${escapeHTML(u.fullName.split(' ')[0])}<span>@${escapeHTML(u.username)}</span>
              </button>`).join('')}
          </div>

          <div class="auth-hint"><strong>Demo accounts:</strong> faizan / kaushik / arya / animesh — password <code>${DEMO_PW}</code></div>
          <p class="footer-text">Don't have an account? <span class="auth-link" id="goRegister" role="button" tabindex="0">Register</span></p>
        </main>
      </div>
    </div>`;
}

function bindLogin() {
  AuthEffects.mount();

  const loginBtn = document.getElementById('loginBtn');
  const loginId = document.getElementById('loginId');
  const loginPw = document.getElementById('loginPw');
  const err = document.getElementById('loginError');

  const showLoginError = (message) => {
    if (!err) return;
    err.textContent = message;
    err.hidden = false;
  };

  const submitLogin = () => {
    const id = loginId?.value.trim() ?? '';
    const pw = loginPw?.value ?? '';
    if (err) err.hidden = true;

    const result = login(id, pw);
    if (!result.success) showLoginError(result.message);
  };

  loginBtn?.addEventListener('click', submitLogin);
  [loginId, loginPw].forEach((input) => {
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLogin();
    });
  });

  document.querySelectorAll('[data-u]').forEach((button) => {
    button.addEventListener('click', () => {
      if (loginId) loginId.value = button.getAttribute('data-u') ?? '';
      if (loginPw) loginPw.value = DEMO_PW;
      if (err) err.hidden = true;
      loginPw?.focus();
    });
  });

  const goRegister = document.getElementById('goRegister');
  goRegister?.addEventListener('click', () => navigate('register'));
  goRegister?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('register'); }
  });
}

const AuthEffects = (() => {
  let bg = null, bctx = null, bgRaf = null;
  let W = 0, H = 0, particles = [], t = 0;
  let nc = null, nctx = null, networkRaf = null, nt = 0;
  let cleanupFns = [];

  const NODES = [
  { x: .5,  y: .38, label: 'FK', main: true },
  { x: .2,  y: .18, label: 'AR' },
  { x: .78, y: .15, label: 'KU' },
  { x: .72, y: .72, label: 'AN' },
  { x: .15, y: .62, label: 'RJ' },
  { x: .88, y: .46, label: 'SM' }
];

  const EDGES = [[0,1],[0,2],[0,3],[1,4],[2,5],[1,2],[3,5]];

  function resize() {
    if (!bg) return;
    W = bg.width = window.innerWidth;
    H = bg.height = window.innerHeight;
    initParticles();
  }

  function initParticles() {
    particles = [];
    const N = Math.min(70, Math.floor(W * H / 14000));
    for (let i = 0; i < N; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: Math.random() * 800 + 200,
        vx: (Math.random() - .5) * .25,
        vy: (Math.random() - .5) * .25,
        vz: (Math.random() - .5) * .4,
        r: Math.random() * 2.5 + 1,
        hue: 200 + Math.random() * 80,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function project(x, y, z) {
    const fov = 600;
    const s = fov / (fov + z);
    return { sx: x * s + W / 2 * (1 - s), sy: y * s + H / 2 * (1 - s), s };
  }

  function drawBg() {
    if (!bctx) return;
    bctx.clearRect(0, 0, W, H);
    bctx.fillStyle = '#080d1a';
    bctx.fillRect(0, 0, W, H);

    t += .008;
    const sorted = [...particles].sort((a, b) => b.z - a.z);

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      if (p.z < 100) p.z = 900; if (p.z > 900) p.z = 100;

      const pulse = Math.sin(t * 2 + p.phase) * .5 + .5;
      const { sx, sy, s } = project(p.x, p.y, p.z);
      const r = p.r * s * (1 + pulse * .3);
      const alpha = s * (.7 + pulse * .3);

      // Draw edges between nearby particles
      for (let j = i + 1; j < sorted.length; j++) {
        const q = sorted[j];
        const { sx: qx, sy: qy, s: qs } = project(q.x, q.y, q.z);
        const dist = Math.hypot(sx - qx, sy - qy);
        const maxDist = 140 + 50 * ((s + qs) / 2);
        if (dist < maxDist) {
          const lineAlpha = ((1 - dist / maxDist) * .22) * Math.min(s, qs) * 1.5;
          const grad = bctx.createLinearGradient(sx, sy, qx, qy);
          grad.addColorStop(0, `hsla(${p.hue},80%,70%,${lineAlpha})`);
          grad.addColorStop(1, `hsla(${q.hue},80%,70%,${lineAlpha})`);
          bctx.beginPath(); bctx.moveTo(sx, sy); bctx.lineTo(qx, qy);
          bctx.strokeStyle = grad; bctx.lineWidth = .6; bctx.stroke();
        }
      }

      // Draw glowing particle
      const gr = bctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
      gr.addColorStop(0, `hsla(${p.hue},90%,75%,${alpha})`);
      gr.addColorStop(.5, `hsla(${p.hue},80%,65%,${alpha * .5})`);
      gr.addColorStop(1, `hsla(${p.hue},70%,60%,0)`);
      bctx.beginPath(); bctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
      bctx.fillStyle = gr; bctx.fill();
    }
    bgRaf = requestAnimationFrame(drawBg);
  }

  function drawNetwork() {
    if (!nc || !nctx) return;
    const width = nc.width  = nc.offsetWidth;
    const height = nc.height = nc.offsetHeight;
    nctx.clearRect(0, 0, width, height);
    nt += .012;

    // Draw edges with flowing gradient animation
    EDGES.forEach(([a, b]) => {
      const na = NODES[a], nb = NODES[b];
      const ax = na.x * width, ay = na.y * height;
      const bx = nb.x * width, by = nb.y * height;
      const flow = Math.sin(nt * 2 - (a + b)) * .5 + .5;
      const g = nctx.createLinearGradient(ax, ay, bx, by);
      g.addColorStop(0,    'rgba(34,211,238,.12)');
      g.addColorStop(flow, 'rgba(34,211,238,.55)');
      g.addColorStop(1,    'rgba(34,211,238,.08)');
      nctx.beginPath(); nctx.moveTo(ax, ay); nctx.lineTo(bx, by);
      nctx.strokeStyle = g; nctx.lineWidth = 1.5; nctx.stroke();
    });

    // Draw nodes with pulse halos
    NODES.forEach((n, i) => {
      const x = n.x * width, y = n.y * height;
      const pulse = Math.sin(nt * 2.5 + i * .8) * .5 + .5;
      const r = n.main ? 26 : 18;

      // Halo
      nctx.beginPath(); nctx.arc(x, y, r + 3 * pulse, 0, Math.PI * 2);
      nctx.fillStyle = `rgba(34,211,238,${.06 + .04 * pulse})`; nctx.fill();

      // Node body
      nctx.beginPath(); nctx.arc(x, y, r, 0, Math.PI * 2);
      nctx.fillStyle = n.main ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.13)'; nctx.fill();
      nctx.strokeStyle = `rgba(255,255,255,${.5 + .3 * pulse})`;
      nctx.lineWidth = 1.5; nctx.stroke();

      // Label
      nctx.fillStyle = '#fff';
      nctx.font = `${n.main ? '700' : '600'} ${n.main ? 11 : 9}px sans-serif`;
      nctx.textAlign = 'center'; nctx.textBaseline = 'middle';
      nctx.fillText(n.label, x, y);
    });

    networkRaf = requestAnimationFrame(drawNetwork);
  }

  function mount() {
    destroy();

    bg = document.getElementById('canvas3d');
    bctx = bg?.getContext('2d') ?? null;
    nc = document.getElementById('loginNetworkCanvas');
    nctx = nc?.getContext('2d') ?? null;

    setTimeout(() => document.getElementById('authContainer')?.classList.add('visible'), 80);

    if (bg && bctx) {
      window.addEventListener('resize', resize);
      cleanupFns.push(() => window.removeEventListener('resize', resize));
      resize();
      drawBg();
    }

    if (nc && nctx) {
      window.addEventListener('resize', drawNetwork);
      cleanupFns.push(() => window.removeEventListener('resize', drawNetwork));
      drawNetwork();
    }

    const card = document.getElementById('authContainer');
    const wrap = document.querySelector('.login-wrap');
    if (card && wrap) {
      card.style.transformStyle = 'preserve-3d';
      wrap.style.perspective = '1200px';

      const onMouseMove = (e) => {
        const rx = ((e.clientY / window.innerHeight) - .5) * 6;
        const ry = ((e.clientX / window.innerWidth)  - .5) * -6;
        card.style.transform = `translateY(0) scale(1) rotateX(${rx}deg) rotateY(${ry}deg)`;
        card.style.transition = 'transform .1s ease';
      };
      const onMouseLeave = () => {
        card.style.transform = 'translateY(0) scale(1) rotateX(0deg) rotateY(0deg)';
        card.style.transition = 'transform .6s ease';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseleave', onMouseLeave);
      cleanupFns.push(() => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseleave', onMouseLeave);
      });
    }
  }

  function destroy() {
    if (bgRaf) cancelAnimationFrame(bgRaf);
    if (networkRaf) cancelAnimationFrame(networkRaf);
    bgRaf = null;
    networkRaf = null;
    cleanupFns.forEach((fn) => { try { fn(); } catch { /* noop */ } });
    cleanupFns = [];
    bg = null; bctx = null; nc = null; nctx = null;
  }

  return { mount, destroy };
})();
/* ============================================================================
 * REGISTER VIEW
 * ========================================================================== */
function renderRegister() {
  return `
    <div class="login-wrap">
    <div class="auth-container visible">
      <div class="auth-card" style="max-width:480px;">
        <h2>Create account</h2>
        <p class="auth-subtitle">Join the Graph Social network</p>

        <form id="registerForm" novalidate>
          <div class="form-group">
            <label for="regName">Full name</label>
            <input type="text" class="form-control" id="regName" placeholder="John Doe" autocomplete="name" />
          </div>
          <div class="form-group">
            <label for="regUsername">Username</label>
            <input type="text" class="form-control" id="regUsername" placeholder="johndoe" autocomplete="username" />
          </div>
          <div class="form-group">
            <label for="regEmail">Email</label>
            <input type="email" class="form-control" id="regEmail" placeholder="john@example.com" autocomplete="email" />
          </div>
          <div class="form-group">
            <label for="regPassword">Password</label>
            <input type="password" class="form-control" id="regPassword" placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label for="regAvatar">Avatar URL <span class="muted">(optional)</span></label>
            <input type="text" class="form-control" id="regAvatar" placeholder="https://â€¦" />
          </div>
          <div class="form-group">
            <label for="regBio">Bio</label>
            <textarea class="form-control" id="regBio" rows="2" placeholder="Tell us about yourselfâ€¦"></textarea>
          </div>
          <div id="registerError" hidden class="form-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-block" style="padding:12px;" id="registerBtn">
            Create account
          </button>
        </form>

        <p style="margin-top:20px;text-align:center;font-size:.9rem;color:var(--text-muted);">
          Already have an account? <span class="auth-link" id="goLogin" role="button" tabindex="0">Sign in</span>
        </p>
      </div>
    </div>
    </div>`;
}

function bindRegister() {
  const form = document.getElementById('registerForm');
  const errorBox = document.getElementById('registerError');

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const data = {
      fullName: document.getElementById('regName').value.trim(),
      username: document.getElementById('regUsername').value.trim(),
      email: document.getElementById('regEmail').value.trim(),
      password: document.getElementById('regPassword').value,
      avatar: document.getElementById('regAvatar').value.trim(),
      bio: document.getElementById('regBio').value.trim(),
    };

    const result = register(data);
    if (!result.success) {
      const first = result.errors?.[0];
      if (first) {
        errorBox.textContent = first.message;
        errorBox.hidden = false;
        const field = document.getElementById(first.field);
        if (field) { field.focus(); field.setAttribute('aria-invalid', 'true'); }
      }
      showToast('Please fix the highlighted fields.', 'error');
    }
  });

  const goLogin = document.getElementById('goLogin');
  goLogin?.addEventListener('click', () => navigate('login'));
  goLogin?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('login'); }
  });
}

/* ============================================================================
 * APP SHELL
 * ========================================================================== */
function navItem(view, label, iconSvg, badge = 0) {
  const active = state.view === view;
  return `
    <button class="nav-item ${active ? 'active' : ''}" data-nav="${view}"
            ${active ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconSvg}</svg>
      <span>${label}</span>
      ${badge > 0 ? `<span class="nav-badge">${badge}</span>` : ''}
    </button>`;
}

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  friends: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  requests: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  suggestions: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  network: '<circle cx="12" cy="12" r="3"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><line x1="9" y1="9" x2="7" y2="7"/><line x1="15" y1="9" x2="17" y2="7"/><line x1="9" y1="15" x2="7" y2="17"/><line x1="15" y1="15" x2="17" y2="17"/>',
  dsa: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  stats: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  reset: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
};

function renderAppShell() {
  const user = state.currentUser;
  if (!user) { state.view = 'login'; return renderLogin(); }

  const pendingCount = state.requests.filter((r) => r.to === user.id).length;

  let contentHTML = '';
  switch (state.view) {
    case 'friends':     contentHTML = renderFriends(); break;
    case 'requests':    contentHTML = renderRequests(); break;
    case 'suggestions': contentHTML = renderSuggestions(); break;
    case 'network':     contentHTML = renderNetwork(); break;
    case 'dsa':         contentHTML = renderDSA(); break;
    case 'stats':       contentHTML = renderStats(); break;
    case 'profile':     contentHTML = renderProfile(); break;
    case 'search':      contentHTML = renderSearch(); break;
    case 'dashboard':
    default:            contentHTML = renderDashboard(); break;
  }

  const themeIcon = state.theme === 'light'
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';

  return `
    <div class="app">
      <header class="topbar">
        <button class="icon-btn hamburger" id="menuBtn" aria-label="Open navigation menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" aria-hidden="true">${ICONS.menu}</svg>
        </button>

        <div class="logo">${LOGO_SVG}<span>Graph Social</span></div>

        <div class="topbar-actions">
          <div class="search-bar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <label class="sr-only" for="globalSearch" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Search users</label>
            <input type="text" id="globalSearch" placeholder="Search usersâ€¦" value="${escapeHTML(state.searchQuery)}"
                   autocomplete="off" />
          </div>

          <button class="icon-btn" id="themeToggle"
                  aria-label="Switch to ${state.theme === 'light' ? 'dark' : 'light'} theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${themeIcon}</svg>
          </button>

          <button class="avatar-btn" id="profileMenuBtn" aria-label="Open your profile">
            ${renderAvatar(user)}
            ${pendingCount > 0 ? `<span class="avatar-badge">${pendingCount > 9 ? '9+' : pendingCount}</span>` : ''}
          </button>
        </div>
      </header>

      <div class="main-wrapper">
        <aside class="sidebar" id="sidebar" aria-label="Main navigation">
          ${navItem('dashboard', 'Dashboard', ICONS.dashboard)}
          ${navItem('friends', 'My Friends', ICONS.friends)}
          ${navItem('requests', 'Requests', ICONS.requests, pendingCount)}
          ${navItem('suggestions', 'People You May Know', ICONS.suggestions)}
          ${navItem('network', 'My Network', ICONS.network)}
          ${navItem('dsa', 'Algorithm Lab', ICONS.dsa)}
          ${navItem('stats', 'Statistics', ICONS.stats)}
          <div class="nav-spacer"></div>
          <div class="nav-divider"></div>
          <button class="nav-item" id="logoutBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.logout}</svg>
            <span>Sign out</span>
          </button>
          <button class="nav-item" id="resetBtn" style="color:var(--danger);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.reset}</svg>
            <span>Reset demo data</span>
          </button>
        </aside>

        <div class="scrim" id="scrim"></div>

        <main class="content" id="mainContent">${contentHTML}</main>
      </div>
    </div>`;
}

/* ============================================================================
 * DASHBOARD
 * ========================================================================== */
function renderDashboard() {
  const user = state.currentUser;
  const friendIds = state.graph.getFriends(user.id);
  const pending = state.requests.filter((r) => r.to === user.id).length;

  // FIX: previously `getMutualFriends(user.id, user.id)` â€” that just returned
  // the user's own friend list. Network reach is the meaningful metric.
  let reach = 0;
  try { reach = Math.max(0, state.graph.bfs(user.id).size - 1); } catch { reach = friendIds.length; }

  const suggestions = state.recommendations.slice(0, 3);
  const totalMutual = state.recommendations.reduce((sum, s) => sum + s.mutualCount, 0);

  return `
    <h1 class="section-title">Dashboard</h1>
    <p class="muted mb-20">Welcome back, ${escapeHTML(user.fullName.split(' ')[0])}.</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Friends</div>
        <div class="stat-value">${friendIds.length}</div>
        <div class="stat-sub">direct connections</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Network reach</div>
        <div class="stat-value">${reach}</div>
        <div class="stat-sub">people within your graph</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending</div>
        <div class="stat-value">${pending}</div>
        <div class="stat-sub">incoming requests</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Suggestions</div>
        <div class="stat-value">${state.recommendations.length}</div>
        <div class="stat-sub">${totalMutual} mutual links</div>
      </div>
    </div>

    <div class="card mb-20">
      <div class="profile-header">
        ${renderAvatar(user, 'avatar-lg')}
        <div class="profile-header-info">
          <h2>${escapeHTML(user.fullName)}</h2>
          <div class="username">@${escapeHTML(user.username)}</div>
          <p class="bio">${escapeHTML(user.bio || 'No bio yet.')}</p>
          <div class="profile-meta">
            <span><strong>${friendIds.length}</strong> friends</span>
            <span><strong>${reach}</strong> reachable</span>
            <span><strong>${state.graph.getEdgeCount()}</strong> total links in network</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">People you may know</div>
        <button class="btn btn-outline btn-sm" data-nav="suggestions">View all</button>
      </div>
      ${suggestions.length === 0
        ? renderEmptyState('No suggestions right now', 'Add a few friends and we will surface people from your extended network.')
        : `<div class="user-grid">${suggestions.map(renderSuggestionCard).join('')}</div>`}
    </div>`;
}

/* ============================================================================
 * EMPTY STATE
 * ========================================================================== */
function renderEmptyState(title, message, actionHTML = '') {
  return `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><path d="M8 15s1.5-2 4-2 4 2 4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
      </svg>
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      ${actionHTML}
    </div>`;
}

/* ============================================================================
 * FRIENDS
 * ========================================================================== */
function renderFriends() {
  const user = state.currentUser;
  const friends = state.graph.getFriends(user.id).map(getUserById).filter(Boolean);

  return `
    <div class="page-heading">
      <div>
        <div class="eyebrow">Your circle</div>
        <h1 class="section-title">My friends <span class="heading-count">${friends.length}</span></h1>
      </div>
      <button class="btn btn-primary" data-nav="suggestions">Find people <span aria-hidden="true">+</span></button>
    </div>

    ${friends.length === 0
      ? renderEmptyState('No friends yet', 'Start by exploring suggestions based on your network.',
          '<button class="btn btn-primary mt-16" data-nav="suggestions">Find people</button>')
      : `<div class="user-grid">
          ${friends.map((friend) => {
            const mutual = state.graph.getMutualFriends(user.id, friend.id);
            return `
              <div class="user-card relationship-card">
                <div class="user-card-top">
                  ${renderAvatar(friend)}
                  <div class="user-card-info">
                    <h4>${escapeHTML(friend.fullName)}</h4>
                    <div class="username">@${escapeHTML(friend.username)}</div>
                    <span class="status-pill status-pill-success">Connected</span>
                    ${mutual.length > 0 ? `<span class="mutual-badge">${mutual.length} mutual</span>` : ''}
                  </div>
                </div>
                <div class="btn-row">
                  <button class="btn btn-outline btn-sm" data-profile="${friend.id}">View profile</button>
                  <button class="btn btn-danger btn-sm" data-remove="${friend.id}">Remove</button>
                </div>
              </div>`;
          }).join('')}
        </div>`}`;
}

/* ============================================================================
 * REQUESTS
 * ========================================================================== */
function renderRequests() {
  const user = state.currentUser;
  const incoming = state.requests
    .map((req, index) => ({ ...req, index }))
    .filter((req) => req.to === user.id);

  const outgoing = state.requests
    .map((req, index) => ({ ...req, index }))
    .filter((req) => req.from === user.id);

  const incomingHTML = incoming.length === 0
    ? renderEmptyState('No pending requests', 'When someone asks to connect, it will appear here.')
    : `<div class="user-grid">
        ${incoming.map((req) => {
          const sender = getUserById(req.from);
          if (!sender) return '';
          const mutual = state.graph.getMutualFriends(user.id, sender.id);
          return `
            <div class="user-card">
              <div class="user-card-top">
                ${renderAvatar(sender)}
                <div class="user-card-info">
                  <h4>${escapeHTML(sender.fullName)}</h4>
                  <div class="username">@${escapeHTML(sender.username)}</div>
                  <span class="status-pill status-pill-warning">Wants to connect</span>
                  ${mutual.length > 0 ? `<span class="mutual-badge">${mutual.length} mutual</span>` : ''}
                </div>
              </div>
              <div class="btn-row">
                <button class="btn btn-success btn-sm" data-accept="${req.index}">Accept</button>
                <button class="btn btn-danger btn-sm" data-reject="${req.index}">Decline</button>
              </div>
            </div>`;
        }).join('')}
      </div>`;

  const outgoingHTML = outgoing.length === 0
    ? `<p class="muted">You have no outgoing requests.</p>`
    : `<div class="user-grid">
        ${outgoing.map((req) => {
          const target = getUserById(req.to);
          if (!target) return '';
          return `
            <div class="user-card">
              <div class="user-card-top">
                ${renderAvatar(target)}
                <div class="user-card-info">
                  <h4>${escapeHTML(target.fullName)}</h4>
                  <div class="username">@${escapeHTML(target.username)}</div>
                  <span class="status-pill">Awaiting reply</span>
                </div>
              </div>
              <div class="btn-row">
                <button class="btn btn-outline btn-sm" data-profile="${target.id}">View profile</button>
              </div>
            </div>`;
        }).join('')}
      </div>`;

  return `
    <h1 class="section-title">Friend requests <span class="heading-count">${incoming.length}</span></h1>

    <div class="card mb-20">
      <div class="card-title mb-16">Incoming</div>
      ${incomingHTML}
    </div>

    <div class="card">
      <div class="card-title mb-16">Sent by you (${outgoing.length})</div>
      ${outgoingHTML}
    </div>`;
}

/* ============================================================================
 * SUGGESTIONS
 * ========================================================================== */
function renderSuggestions() {
  refreshRecommendations();
  const recs = state.recommendations;

  return `
    <div class="page-heading">
      <div>
        <div class="eyebrow">Recommended</div>
        <h1 class="section-title">People you may know <span class="heading-count">${recs.length}</span></h1>
      </div>
    </div>
    <p class="muted mb-20">
      Ranked by a weighted blend of <strong>Adamicâ€“Adar</strong> (shared rare friends),
      <strong>Jaccard similarity</strong>, <strong>graph proximity</strong> and <strong>popularity</strong>.
    </p>

    ${recs.length === 0
      ? renderEmptyState('No suggestions available', 'You may already be connected to everyone within reach. Try removing a few filters or inviting new people.')
      : `<div class="user-grid">${recs.map(renderSuggestionCard).join('')}</div>`}`;
}

function renderSuggestionCard(s) {
  const maxScore = state.recommendations[0]?.score || 1;
  const pct = Math.max(6, Math.round((s.score / maxScore) * 100));
  const mutualNames = s.mutualFriends.slice(0, 3).map((u) => u.fullName).join(', ');
  const more = s.mutualFriends.length > 3 ? ` +${s.mutualFriends.length - 3} more` : '';

  return `
    <div class="user-card relationship-card">
      <div class="user-card-top">
        ${renderAvatar(s.user)}
        <div class="user-card-info">
          <h4>${escapeHTML(s.user.fullName)}</h4>
          <div class="username">@${escapeHTML(s.user.username)}</div>
          <span class="status-pill">Suggested</span>
          <span class="mutual-badge">${s.mutualCount} mutual</span>
        </div>
      </div>

      <div class="score-bar" title="Match score ${(s.score * 100).toFixed(0)}%">
        <i style="width:${pct}%"></i>
      </div>

      ${s.mutualFriends.length > 0
        ? `<div class="mutual-names">Mutual: ${escapeHTML(mutualNames)}${escapeHTML(more)}</div>`
        : ''}

      <div class="btn-row">
        <button class="btn btn-primary btn-sm" data-add="${s.user.id}">Add friend</button>
        <button class="btn btn-outline btn-sm" data-profile="${s.user.id}">View</button>
      </div>
    </div>`;
}

/* ============================================================================
 * PROFILE
 * ========================================================================== */
function renderProfile() {
  const profileId = state.selectedProfile || state.currentUser.id;
  const user = getUserById(profileId);
  if (!user) {
    return renderEmptyState('User not found', 'This profile may have been removed.',
      '<button class="btn btn-primary mt-16" data-nav="dashboard">Back to dashboard</button>');
  }

  const current = state.currentUser;
  const isMe = user.id === current.id;
  const areFriends = state.graph.areFriends(current.id, user.id);
  const friends = state.graph.getFriends(user.id).map(getUserById).filter(Boolean);
  const mutual = isMe ? [] : state.graph.getMutualFriends(current.id, user.id);

  const hasPendingSent = state.requests.some((r) => r.from === current.id && r.to === user.id);
  const hasPendingReceived = state.requests.some((r) => r.from === user.id && r.to === current.id);
  const wasRejected = state.rejected.includes([current.id, user.id].sort().join('|'));

  let actionHTML = '';
  if (isMe) actionHTML = '<span class="muted">This is you</span>';
  else if (areFriends) actionHTML = `<button class="btn btn-danger btn-sm" data-remove="${user.id}">Remove friend</button>`;
  else if (hasPendingSent) actionHTML = '<span class="status-pill status-pill-warning">Request pending</span>';
  else if (hasPendingReceived) actionHTML = `<span class="status-pill status-pill-success">They sent you a request</span>`;
  else if (wasRejected) actionHTML = '<span class="status-pill">Previously declined</span>';
  else actionHTML = `<button class="btn btn-primary btn-sm" data-add="${user.id}">Add friend</button>`;

  let degrees = null;
  if (!isMe) {
    try {
      const result = state.graph.bfsShortestPath(current.id, user.id);
      degrees = result ? result.hops : null;
    } catch { degrees = null; }
  }

  return `
    <button class="btn btn-outline btn-sm mb-20" data-nav="dashboard">â† Back</button>

    <div class="card mb-20">
      <div class="profile-header">
        ${renderAvatar(user, 'avatar-xl')}
        <div class="profile-header-info">
          <h2>${escapeHTML(user.fullName)}</h2>
          <div class="username">@${escapeHTML(user.username)}</div>
          <p class="bio">${escapeHTML(user.bio || 'No bio.')}</p>
          <div class="profile-meta">
            <span><strong>${friends.length}</strong> friends</span>
            ${!isMe ? `<span><strong>${mutual.length}</strong> mutual</span>` : ''}
            ${!isMe && degrees !== null ? `<span><strong>${degrees}</strong> degrees of separation</span>` : ''}
            ${!isMe && degrees === null ? `<span class="muted">Not connected to your network</span>` : ''}
          </div>
          <div class="mt-16">${actionHTML}</div>
        </div>
      </div>
    </div>

    ${!isMe && mutual.length > 0 ? `
      <div class="card mb-20">
        <div class="card-title mb-16">Mutual friends (${mutual.length})</div>
        <div class="user-grid">
          ${mutual.map((m) => `
            <div class="user-card">
              <div class="user-card-top">
                ${renderAvatar(m)}
                <div class="user-card-info">
                  <h4>${escapeHTML(m.fullName)}</h4>
                  <div class="username">@${escapeHTML(m.username)}</div>
                </div>
              </div>
              <div class="btn-row">
                <button class="btn btn-outline btn-sm" data-profile="${m.id}">View</button>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-title mb-16">Friends (${friends.length})</div>
      ${friends.length === 0
        ? '<p class="muted">No friends yet.</p>'
        : `<div class="user-grid">
            ${friends.map((f) => `
              <div class="user-card">
                <div class="user-card-top">
                  ${renderAvatar(f)}
                  <div class="user-card-info">
                    <h4>${escapeHTML(f.fullName)}</h4>
                    <div class="username">@${escapeHTML(f.username)}</div>
                  </div>
                </div>
                <div class="btn-row">
                  <button class="btn btn-outline btn-sm" data-profile="${f.id}">View</button>
                </div>
              </div>`).join('')}
          </div>`}
    </div>`;
}

/* ============================================================================
 * SEARCH
 * ========================================================================== */
function renderSearch() {
  const query = state.searchQuery.trim().toLowerCase();

  const results = query
    ? state.users.filter((u) =>
        u.fullName.toLowerCase().includes(query) ||
        u.username.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query))
    : [];

  const resultsHTML = !query
    ? renderEmptyState('Start typing to search', 'Find people by name, username or email address.')
    : results.length === 0
      ? renderEmptyState('No matches found', `Nothing matched â€œ${query}â€. Try a different spelling.`)
      : `<div class="user-grid">
          ${results.map((u) => {
            const isMe = u.id === state.currentUser.id;
            const areFriends = state.graph.areFriends(state.currentUser.id, u.id);
            const pending = state.requests.some(
              (r) => (r.from === state.currentUser.id && r.to === u.id) ||
                     (r.to === state.currentUser.id && r.from === u.id));
            return `
              <div class="user-card">
                <div class="user-card-top">
                  ${renderAvatar(u)}
                  <div class="user-card-info">
                    <h4>${escapeHTML(u.fullName)}</h4>
                    <div class="username">@${escapeHTML(u.username)}</div>
                    ${areFriends ? '<span class="status-pill status-pill-success">Friends</span>' : ''}
                    ${pending ? '<span class="status-pill status-pill-warning">Pending</span>' : ''}
                  </div>
                </div>
                <div class="btn-row">
                  <button class="btn btn-outline btn-sm" data-profile="${u.id}">View profile</button>
                  ${!isMe && !areFriends && !pending
                    ? `<button class="btn btn-primary btn-sm" data-add="${u.id}">Add friend</button>` : ''}
                </div>
              </div>`;
          }).join('')}
        </div>`;

  return `
    <h1 class="section-title">Search</h1>
    <div class="form-group" style="max-width:420px;margin-top:14px;">
      <label for="searchInput" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Search users</label>
      <input type="search" class="form-control" id="searchInput"
             placeholder="Search by name, username or emailâ€¦"
             value="${escapeHTML(state.searchQuery)}" autocomplete="off" />
    </div>
    ${resultsHTML}`;
}

/* ============================================================================
 * STATISTICS
 * ========================================================================== */
function renderStats() {
  const analytics = state.graph.getAnalytics();
  const myFriends = state.graph.getFriends(state.currentUser.id).length;
  const pending = state.requests.filter((r) => r.to === state.currentUser.id).length;

  let reach = 0;
  try { reach = Math.max(0, state.graph.bfs(state.currentUser.id).size - 1); } catch { reach = 0; }

  const hubs = analytics.hubs
    .map((h) => ({ ...h, user: getUserById(h.id) }))
    .filter((h) => h.user);

  return `
    <h1 class="section-title">Statistics</h1>
    <p class="muted mb-20">Global analytics computed from the live adjacency list.</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total users</div>
        <div class="stat-value">${analytics.users}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total friendships</div>
        <div class="stat-value">${analytics.edges}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Graph density</div>
        <div class="stat-value">${(analytics.density * 100).toFixed(1)}%</div>
        <div class="stat-sub">edges Ã· possible edges</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Average degree</div>
        <div class="stat-value">${formatNumber(analytics.avgDegree)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Diameter</div>
        <div class="stat-value">${analytics.diameter}</div>
        <div class="stat-sub">longest shortest path</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Components</div>
        <div class="stat-value">${analytics.components}</div>
        <div class="stat-sub">disconnected islands</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Clustering</div>
        <div class="stat-value">${(analytics.clustering * 100).toFixed(0)}%</div>
        <div class="stat-sub">friend-of-friend density</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Your reach</div>
        <div class="stat-value">${reach}</div>
        <div class="stat-sub">${myFriends} direct Â· ${pending} pending</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title mb-16">Most connected people</div>
      <table class="data-table">
        <thead>
          <tr><th>#</th><th>User</th><th>Degree</th><th>Share of network</th></tr>
        </thead>
        <tbody>
          ${hubs.map((h, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-profile="${h.user.id}" style="padding:0;">
                  ${escapeHTML(h.user.fullName)}
                </button>
              </td>
              <td class="mono">${h.degree}</td>
              <td class="mono">${analytics.users > 1 ? ((h.degree / (analytics.users - 1)) * 100).toFixed(0) : 0}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ============================================================================
 * NETWORK VIEW â€” force-directed, interactive canvas
 * ========================================================================== */
function renderNetwork() {
  const currentId = state.currentUser.id;
  const friendCount = state.graph.getFriends(currentId).length;
  const edgeCount = state.graph.getEdgeCount();
  let reachable = 0;
  try { reachable = Math.max(0, state.graph.bfs(currentId).size - 1); } catch { reachable = 0; }

  const n = state.users.length;
  const density = n > 1 ? Math.round((edgeCount / ((n * (n - 1)) / 2)) * 100) : 0;

  return `
    <div class="network-heading">
      <div>
        <div class="eyebrow">Live graph explorer</div>
        <h1 class="section-title">My network</h1>
        <p class="network-subtitle">
          Drag nodes to rearrange, scroll to zoom, drag the background to pan. Click a node to open its profile.
        </p>
      </div>
      <div class="network-controls">
        <button class="btn btn-outline btn-sm" id="networkRefresh">â†» Re-layout</button>
        <button class="btn btn-outline btn-sm" id="networkFit">â¤¢ Fit</button>
        <button class="btn btn-primary btn-sm" data-nav="suggestions">Grow network +</button>
      </div>
    </div>

    <div class="network-stats">
      <div class="network-stat">
        <span class="network-stat-icon network-icon-blue">â—</span>
        <div><strong>${state.users.length}</strong><span>People</span></div>
      </div>
      <div class="network-stat">
        <span class="network-stat-icon network-icon-green">â™¥</span>
        <div><strong>${friendCount}</strong><span>Your friends</span></div>
      </div>
      <div class="network-stat">
        <span class="network-stat-icon network-icon-orange">â†”</span>
        <div><strong>${edgeCount}</strong><span>Connections</span></div>
      </div>
      <div class="network-stat">
        <span class="network-stat-icon network-icon-purple">â—‰</span>
        <div><strong>${reachable}</strong><span>Reachable nodes</span></div>
      </div>
      <div class="network-density">
        <span>Graph density</span>
        <strong>${density}%</strong>
        <div><i style="width:${Math.min(density, 100)}%"></i></div>
      </div>
    </div>

    <div class="network-stage">
      <div class="network-stage-label">
        <span class="live-dot"></span>
        <span>Live relationship map</span>
        <span id="networkNodeHint">Hover a node to inspect</span>
      </div>
      <canvas id="networkCanvas" role="img"
              aria-label="Interactive force-directed graph of your social network"></canvas>
    </div>

    <div class="network-legend">
      <span><i class="legend-dot" style="background:#2563eb"></i>You</span>
      <span><i class="legend-dot" style="background:#10b981"></i>Direct friends</span>
      <span><i class="legend-dot" style="background:#f59e0b"></i>Friends of friends</span>
      <span><i class="legend-dot" style="background:#94a3b8"></i>Outside your reach</span>
    </div>`;
}

/* ============================================================================
 * NETWORK VIEW CONTROLLER
 * ========================================================================== */
const NetworkView = (() => {
  let canvas = null, ctx = null;
  let nodes = [], links = [];
  let rafId = null;
  let alpha = 1;
  let hovered = null;
  let dragging = null;
  let panning = null;
  let view = { x: 0, y: 0, scale: 1 };
  let W = 0, H = 0, dpr = 1;
  let cleanupFns = [];

  const NODE_R = 17;
  const MAX_ALPHA = 1;
  const MIN_ALPHA = 0.003;

  function toScreen(p) {
    return {
      x: (p.x + view.x) * view.scale + W / 2,
      y: (p.y + view.y) * view.scale + H / 2,
    };
  }
  function toWorld(sx, sy) {
    return {
      x: (sx - W / 2) / view.scale - view.x,
      y: (sy - H / 2) / view.scale - view.y,
    };
  }

  function buildGraph() {
    const currentId = state.currentUser.id;
    let distances;
    try { distances = state.graph.bfs(currentId); }
    catch { distances = new Map([[currentId, 0]]); }

    const radius = Math.min(W, H) * 0.34;
    nodes = state.users.map((user, index) => {
      const angle = (index / Math.max(1, state.users.length)) * Math.PI * 2;
      const jitter = 0.75 + Math.random() * 0.5;
      const dist = distances.has(user.id) ? distances.get(user.id) : Infinity;
      return {
        id: user.id,
        user,
        dist,
        x: Math.cos(angle) * radius * jitter,
        y: Math.sin(angle) * radius * jitter,
        vx: 0, vy: 0,
        r: user.id === currentId ? NODE_R + 6 : NODE_R,
      };
    });

    const index = new Map(nodes.map((n) => [n.id, n]));
    links = [];
    const seen = new Set();
    for (const [a, friends] of state.graph.adjacency) {
      for (const b of friends) {
        const key = [a, b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const na = index.get(a), nb = index.get(b);
        if (na && nb) links.push({ a: na, b: nb, cost: state.graph.edgeCost(a, b) });
      }
    }
  }

  function simulate() {
    if (alpha < MIN_ALPHA) { rafId = null; return; }

    const centerForce = 0.012;
    const linkLength = Math.min(W, H) * 0.16;
    const linkStrength = 0.06;
    const repulsion = 4200;

    // Repulsion (O(nÂ²) â€” fine for a few hundred nodes)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const force = (repulsion * alpha) / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Springs
    for (const link of links) {
      const dx = link.b.x - link.a.x;
      const dy = link.b.y - link.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = (d - linkLength) / d;
      const force = diff * linkStrength * alpha;
      const fx = dx * force, fy = dy * force;
      link.a.vx += fx; link.a.vy += fy;
      link.b.vx -= fx; link.b.vy -= fy;
    }

    // Gravity to centre + integration
    for (const node of nodes) {
      if (node === dragging) { node.vx = 0; node.vy = 0; continue; }
      node.vx -= node.x * centerForce * alpha;
      node.vy -= node.y * centerForce * alpha;
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += node.vx;
      node.y += node.vy;
    }

    alpha *= 0.985;
    draw();
    rafId = requestAnimationFrame(simulate);
  }

  function colorFor(node) {
    const currentId = state.currentUser.id;
    if (node.id === currentId) return '#2563eb';
    if (node.dist === 1) return '#10b981';
    if (node.dist === 2) return '#f59e0b';
    return '#94a3b8';
  }

  function draw() {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const styles = getComputedStyle(document.documentElement);
    const surfaceColor = styles.getPropertyValue('--surface').trim() || '#fff';
    const mutedColor = styles.getPropertyValue('--text-muted').trim() || '#64748b';

    // Edges
    for (const link of links) {
      const isHighlighted = hovered && (link.a === hovered || link.b === hovered);
      const active = link.a.dist <= 2 && link.b.dist <= 2;

      ctx.beginPath();
      ctx.moveTo(...Object.values(toScreen(link.a)).slice(0, 2));
      const p1 = toScreen(link.a), p2 = toScreen(link.b);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineWidth = isHighlighted ? 2.6 : active ? 1.6 : 1;
      ctx.strokeStyle = isHighlighted
        ? 'rgba(37,99,235,0.85)'
        : active ? 'rgba(100,116,139,0.42)' : 'rgba(148,163,184,0.20)';
      ctx.stroke();
    }

    // Nodes
    for (const node of nodes) {
      const p = toScreen(node);
      const r = node.r * view.scale;
      const isHovered = node === hovered;

      if (node.id === state.currentUser.id) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 10 * view.scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(37,99,235,0.14)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(node);
      ctx.fill();
      ctx.lineWidth = (isHovered ? 4 : 2.5) * view.scale;
      ctx.strokeStyle = isHovered ? '#2563eb' : surfaceColor;
      ctx.stroke();

      // Initials
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.max(9, 11 * view.scale)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getInitials(node.user.fullName), p.x, p.y + 1);

      // Name label
      if (view.scale > 0.55) {
        ctx.fillStyle = mutedColor;
        ctx.font = `${Math.max(9, 10 * view.scale)}px Inter, sans-serif`;
        ctx.fillText(node.user.fullName.split(' ')[0], p.x, p.y + r + 13 * view.scale);
      }
    }
  }

  function hitTest(sx, sy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const p = toScreen(node);
      const r = node.r * view.scale + 6;
      if ((sx - p.x) ** 2 + (sy - p.y) ** 2 <= r * r) return node;
    }
    return null;
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  }

  function fit() {
    view = { x: 0, y: 0, scale: 1 };
    let maxExtent = 1;
    for (const node of nodes) maxExtent = Math.max(maxExtent, Math.abs(node.x), Math.abs(node.y));
    const target = Math.min(W, H) * 0.42;
    view.scale = Math.max(0.35, Math.min(1.6, target / (maxExtent + NODE_R * 2)));
    draw();
  }

  function reheat() { alpha = MAX_ALPHA; if (!rafId) rafId = requestAnimationFrame(simulate); }

  function mount(target) {
    canvas = target;
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    resize();
    buildGraph();
    reheat();
    setTimeout(fit, 900);

    const onMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (dragging) {
        const world = toWorld(sx, sy);
        dragging.x = world.x;
        dragging.y = world.y;
        alpha = Math.max(alpha, 0.25);
        if (!rafId) rafId = requestAnimationFrame(simulate);
        return;
      }
      if (panning) {
        view.x += (e.clientX - panning.x) / view.scale;
        view.y += (e.clientY - panning.y) / view.scale;
        panning.x = e.clientX;
        panning.y = e.clientY;
        draw();
        return;
      }

      const node = hitTest(sx, sy);
      if (node !== hovered) { hovered = node; draw(); }
      canvas.style.cursor = node ? 'pointer' : 'grab';

      const hint = document.getElementById('networkNodeHint');
      if (hint) {
        if (!node) hint.textContent = 'Hover a node to inspect';
        else {
          const label = node.dist === 0 ? 'You'
            : node.dist === 1 ? 'Direct friend'
            : node.dist === 2 ? 'Friend of a friend'
            : node.dist === 3 ? '3 hops away'
            : 'Outside your reach';
          hint.textContent = `${node.user.fullName} Â· ${label}`;
        }
      }
    };

    const onMouseDown = (e) => {
      const rect = canvas.getBoundingClientRect();
      const node = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (node) { dragging = node; node.fixed = true; }
      else { panning = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; }
    };

    const onMouseUp = () => { dragging = null; panning = null; if (canvas) canvas.style.cursor = 'grab'; };

    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const node = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (node) navigate('profile', { profileId: node.id });
    };

    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);

      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.scale = Math.max(0.25, Math.min(3, view.scale * factor));

      const after = toWorld(sx, sy);
      view.x += after.x - before.x;
      view.y += after.y - before.y;
      draw();
    };

    const onResize = () => { resize(); };
    const onLeave = () => { hovered = null; dragging = null; panning = null; draw(); };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);

    document.getElementById('networkRefresh')?.addEventListener('click', () => {
      buildGraph(); reheat(); setTimeout(fit, 800);
    });
    document.getElementById('networkFit')?.addEventListener('click', fit);

    cleanupFns.push(() => {
      canvas?.removeEventListener('mousemove', onMouseMove);
      canvas?.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      canvas?.removeEventListener('click', onClick);
      canvas?.removeEventListener('wheel', onWheel);
      canvas?.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
    });
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    cleanupFns.forEach((fn) => { try { fn(); } catch { /* noop */ } });
    cleanupFns = [];
    canvas = null; ctx = null; nodes = []; links = []; hovered = null; dragging = null; panning = null;
    view = { x: 0, y: 0, scale: 1 };
  }

  return { mount, destroy };
})();

/* ============================================================================
 * DSA LAB â€” stepped BFS & Dijkstra animation
 * ========================================================================== */
function renderDSA() {
  const currentId = state.currentUser.id;
  const currentUser = getUserById(currentId);
  const options = state.users
    .map((u) => `<option value="${u.id}">${escapeHTML(u.fullName)}</option>`)
    .join('');

  return `
    <h1 class="section-title">Algorithm lab</h1>
    <p class="muted mb-20">
      Step through the exact algorithms that power recommendations and path-finding
      on your live graph.
    </p>

    <div class="card mb-20">
      <div class="card-title mb-16">Run a traversal</div>

      <div class="dsa-controls">
        <div>
          <label class="muted" style="display:block;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Algorithm</label>
          <div class="segmented" role="tablist" aria-label="Algorithm">
            <button data-mode="bfs" class="active" role="tab" aria-selected="true">BFS</button>
            <button data-mode="dijkstra" role="tab" aria-selected="false">Dijkstra</button>
          </div>
        </div>

        <div class="form-group" style="min-width:170px;margin-bottom:0;">
          <label for="dsaStart">Start node</label>
          <select class="form-control" id="dsaStart">
            ${options.replace(`value="${currentId}"`, `value="${currentId}" selected`)}
          </select>
        </div>

        <div class="form-group" id="dsaTargetGroup" style="min-width:170px;margin-bottom:0;display:none;">
          <label for="dsaTarget">Target node</label>
          <select class="form-control" id="dsaTarget">${options}</select>
        </div>

        <div class="form-group" style="min-width:130px;margin-bottom:0;">
          <label for="dsaSpeed">Speed</label>
          <select class="form-control" id="dsaSpeed">
            <option value="900">Slow</option>
            <option value="500" selected>Normal</option>
            <option value="180">Fast</option>
          </select>
        </div>

        <div class="btn-row" style="margin-top:0;">
          <button class="btn btn-primary" id="dsaPlay">â–¶ Play</button>
          <button class="btn btn-outline" id="dsaStep">Step</button>
          <button class="btn btn-outline" id="dsaReset">Reset</button>
        </div>
      </div>

      <div class="network-stage">
        <div class="network-stage-label">
          <span class="live-dot"></span>
          <span id="dsaStatus">Ready â€” press Play</span>
        </div>
        <canvas id="dsaCanvas" role="img" aria-label="Animated graph traversal"></canvas>
      </div>

      <div class="network-legend" style="margin-top:14px;">
        <span><i class="legend-swatch" style="background:#94a3b8"></i>Unvisited</span>
        <span><i class="legend-swatch" style="background:#f59e0b"></i>In queue / frontier</span>
        <span><i class="legend-swatch" style="background:#2563eb"></i>Current</span>
        <span><i class="legend-swatch" style="background:#10b981"></i>Settled</span>
        <span><i class="legend-swatch" style="background:#8b5cf6"></i>Final path</span>
      </div>

      <div class="dsa-log" id="dsaLog" aria-live="polite"></div>
    </div>

    <div class="card mb-20">
      <div class="card-title mb-16">How it works</div>
      <div class="code-block">
<span class="c">// Undirected adjacency list â€” O(V + E) space</span>
<span class="k">graph</span> = Map&lt;userId, Set&lt;userId&gt;&gt;

<span class="c">// BFS â€” fewest hops. O(V + E)</span>
<span class="k">queue</span> = [start]; <span class="k">dist</span>[start] = 0
<span class="k">while</span> queue not empty:
    node = queue.shift()
    <span class="k">for</span> neighbour of graph[node]:
        <span class="k">if</span> neighbour not visited:
            dist[neighbour] = dist[node] + 1
            queue.push(neighbour)

<span class="c">// Dijkstra â€” cheapest weighted path. O((V + E) log V) with a binary heap</span>
<span class="c">// Edge cost = 1 + 2 / (1 + mutualFriends)  âˆˆ (1, 3]</span>
<span class="k">heap</span> = MinHeap([{ id: start, dist: 0 }])
<span class="k">while</span> heap not empty:
    { id, dist } = heap.pop()          <span class="c">// greedy: closest unsettled node</span>
    <span class="k">if</span> settled(id) <span class="k">continue</span>
    settled.add(id)
    <span class="k">for</span> neighbour of graph[id]:
        candidate = dist + edgeCost(id, neighbour)
        <span class="k">if</span> candidate &lt; best[neighbour]:
            best[neighbour] = candidate
            prev[neighbour] = id
            heap.push({ id: neighbour, dist: candidate })
      </div>
    </div>

    <div class="card">
      <div class="card-title mb-16">BFS levels from ${escapeHTML(currentUser.fullName)}</div>
      ${renderBfsLevels(currentId)}
    </div>`;
}

function renderBfsLevels(startId) {
  let distances;
  try { distances = state.graph.bfs(startId); }
  catch { return '<p class="muted">Could not compute levels.</p>'; }

  const levels = new Map();
  for (const [id, dist] of distances) {
    if (!levels.has(dist)) levels.set(dist, []);
    levels.get(dist).push(id);
  }

  const maxLevel = Math.max(0, ...levels.keys());
  let html = '';
  for (let i = 0; i <= maxLevel; i++) {
    const ids = levels.get(i) ?? [];
    const names = ids.map((id) => getUserName(id)).join(', ') || '(none)';
    let hint = '';
    if (i === 0) hint = 'â† you (start node)';
    else if (i === 2) hint = 'â† friends of friends (suggestion candidates)';
    html += `
      <div class="level-box">
        <strong>Level ${i}:</strong> ${escapeHTML(names)}
        ${hint ? `<span class="hint">${hint}</span>` : ''}
      </div>`;
  }
  return html;
}

/* ---------- DSA Lab controller ---------- */
const DsaLab = (() => {
  let canvas = null, ctx = null;
  let W = 0, H = 0, dpr = 1;
  let positions = new Map();
  let frames = [];
  let frameIndex = 0;
  let timer = null;
  let mode = 'bfs';
  let startId = null;
  let targetId = null;
  let speed = 500;
  let cleanup = null;

  function computeLayout() {
    positions = new Map();
    const ids = state.graph.getAllUsers();
    const centerX = W / 2, centerY = H / 2;

    let distances;
    try { distances = state.graph.bfs(startId); }
    catch { distances = new Map([[startId, 0]]); }

    const levels = new Map();
    for (const id of ids) {
      const dist = distances.has(id) ? distances.get(id) : Infinity;
      if (!levels.has(dist)) levels.set(dist, []);
      levels.get(dist).push(id);
    }

    const finite = [...levels.keys()].filter(Number.isFinite);
    const maxDist = finite.length ? Math.max(...finite, 1) : 1;
    const baseRadius = Math.min(W, H) * 0.40;

    for (const [dist, levelIds] of levels) {
      const radius = Number.isFinite(dist) ? (dist / maxDist) * baseRadius : baseRadius;
      levelIds.forEach((id, i) => {
        const angle = (i / levelIds.length) * Math.PI * 2 - Math.PI / 2
          + (Number.isFinite(dist) ? 0 : 0.22);
        positions.set(id, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
          dist,
        });
      });
    }
  }

  function buildBfsFrames() {
    const out = [];
    const visited = new Set([startId]);
    const queue = [startId];
    let head = 0;

    out.push({
      visited: new Set(), frontier: new Set([startId]), current: null, path: [],
      note: `Initialise queue with ${getUserName(startId)}.`,
      type: 'init',
    });

    while (head < queue.length) {
      const current = queue[head++];
      visited.add(current);
      const discovered = [];

      for (const neighbour of state.graph.adjacency.get(current) ?? []) {
        if (!visited.has(neighbour) && !queue.includes(neighbour)) {
          queue.push(neighbour);
          discovered.push(neighbour);
        }
      }

      const frontier = new Set(queue.slice(head));
      const note = discovered.length
        ? `Dequeue ${getUserName(current)} â†’ discovered ${discovered.map(getUserName).join(', ')}.`
        : `Dequeue ${getUserName(current)} â†’ no new neighbours.`;

      out.push({
        visited: new Set(visited),
        frontier,
        current,
        path: [],
        note,
        type: 'visit',
        discovered,
      });
    }

    out.push({
      visited: new Set(visited), frontier: new Set(), current: null, path: [],
      note: `BFS complete â€” visited ${visited.size} node${visited.size === 1 ? '' : 's'}.`,
      type: 'done',
    });

    return out;
  }

  function buildDijkstraFrames() {
    const out = [];
    const dist = new Map();
    const settled = new Set();
    const prev = new Map();
    const heap = new MinHeap();

    for (const id of state.graph.getAllUsers()) dist.set(id, Infinity);
    dist.set(startId, 0);
    heap.push({ id: startId, dist: 0 });

    out.push({
      settled: new Set(), frontier: new Set([startId]), current: null,
      dist: new Map(dist), path: [],
      note: `Set dist[${getUserName(startId)}] = 0, everything else âˆž.`,
      type: 'init',
    });

    let guard = 0;
    while (heap.size > 0 && guard++ < 5000) {
      const top = heap.pop();
      if (!top || settled.has(top.id)) continue;

      settled.add(top.id);
      const relaxations = [];

      for (const neighbour of state.graph.adjacency.get(top.id) ?? []) {
        if (settled.has(neighbour)) continue;
        const weight = state.graph.edgeCost(top.id, neighbour);
        const candidate = dist.get(top.id) + weight;
        if (candidate < dist.get(neighbour) - 1e-9) {
          dist.set(neighbour, candidate);
          prev.set(neighbour, top.id);
          heap.push({ id: neighbour, dist: candidate });
          relaxations.push({ id: neighbour, cost: candidate });
        }
      }

      const note = relaxations.length
        ? `Settle ${getUserName(top.id)} (d=${dist.get(top.id).toFixed(2)}) â†’ relax ${relaxations.map((r) => `${getUserName(r.id)} (${r.cost.toFixed(2)})`).join(', ')}.`
        : `Settle ${getUserName(top.id)} (d=${dist.get(top.id).toFixed(2)}) â†’ no improvements.`;

      out.push({
        settled: new Set(settled),
        frontier: new Set(heap.items.map((i) => i.id).filter((id) => !settled.has(id))),
        current: top.id,
        dist: new Map(dist),
        path: [],
        note,
        type: 'settle',
      });
    }

    // Highlight the final path if a target was chosen.
    let finalPath = [];
    if (targetId && Number.isFinite(dist.get(targetId))) {
      let node = targetId;
      let guard2 = 0;
      while (node !== undefined && guard2++ < 500) {
        finalPath.unshift(node);
        if (node === startId) break;
        node = prev.get(node);
      }
    }

    out.push({
      settled: new Set(settled),
      frontier: new Set(),
      current: null,
      dist: new Map(dist),
      path: finalPath,
      note: finalPath.length > 1
        ? `Shortest weighted path found: ${finalPath.map(getUserName).join(' â†’ ')} (cost ${dist.get(targetId).toFixed(2)}).`
        : 'Dijkstra complete â€” all reachable nodes settled.',
      type: 'done',
    });

    return out;
  }

  function draw(frame) {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const styles = getComputedStyle(document.documentElement);
    const surfaceColor = styles.getPropertyValue('--surface').trim() || '#fff';
    const mutedColor = styles.getPropertyValue('--text-muted').trim() || '#64748b';

    const pathSet = new Set(frame?.path ?? []);
    const pathEdges = new Set();
    if (pathSet.size > 1) {
      const arr = [...pathSet];
      for (let i = 0; i < arr.length - 1; i++) pathEdges.add([arr[i], arr[i + 1]].sort().join('|'));
    }

    // Edges
    const seen = new Set();
    for (const [a, friends] of state.graph.adjacency) {
      for (const b of friends) {
        const key = [a, b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = positions.get(a), pb = positions.get(b);
        if (!pa || !pb) continue;

        const onPath = pathEdges.has(key);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.lineWidth = onPath ? 4 : 1.6;
        ctx.strokeStyle = onPath ? '#8b5cf6' : 'rgba(148,163,184,0.35)';
        ctx.stroke();
      }
    }

    // Nodes
    for (const [id, pos] of positions) {
      const user = getUserById(id);
      if (!user) continue;

      let fill = '#94a3b8';
      if (pathSet.has(id)) fill = '#8b5cf6';
      else if (frame?.current === id) fill = '#2563eb';
      else if (frame?.settled?.has(id) || frame?.visited?.has(id)) fill = '#10b981';
      else if (frame?.frontier?.has(id)) fill = '#f59e0b';

      const radius = id === startId ? 24 : 19;

      if (frame?.current === id) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(37,99,235,0.16)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = surfaceColor;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = '700 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getInitials(user.fullName), pos.x, pos.y + 1);

      // Distance label (Dijkstra only)
      if (mode === 'dijkstra' && frame?.dist) {
        const d = frame.dist.get(id);
        if (Number.isFinite(d)) {
          ctx.fillStyle = mutedColor;
          ctx.font = '700 10px JetBrains Mono, monospace';
          ctx.fillText(d.toFixed(1), pos.x, pos.y - radius - 9);
        }
      }

      ctx.fillStyle = mutedColor;
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(user.fullName.split(' ')[0], pos.x, pos.y + radius + 14);
    }
  }

  function appendLog(text, kind = '') {
    const log = document.getElementById('dsaLog');
    if (!log) return;
    const line = document.createElement('div');
    if (kind) line.className = kind;
    line.textContent = `â€º ${text}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(text) {
    const el = document.getElementById('dsaStatus');
    if (el) el.textContent = text;
  }

  function showFrame(index) {
    if (frames.length === 0) return;
    frameIndex = Math.max(0, Math.min(index, frames.length - 1));
    const frame = frames[frameIndex];
    draw(frame);
    setStatus(`Step ${frameIndex + 1} / ${frames.length}`);
    appendLog(frame.note, frame.type === 'done' ? 'ok' : '');
  }

  function build() {
    startId = document.getElementById('dsaStart')?.value ?? state.currentUser.id;
    targetId = document.getElementById('dsaTarget')?.value ?? null;
    speed = Number(document.getElementById('dsaSpeed')?.value ?? 500);

    if (!state.graph.hasUser(startId)) {
      startId = state.currentUser.id;
      showToast('Invalid start node â€” defaulting to you.', 'warning');
    }

    computeLayout();
    frames = mode === 'bfs' ? buildBfsFrames() : buildDijkstraFrames();
    frameIndex = 0;

    const log = document.getElementById('dsaLog');
    if (log) log.innerHTML = '';
    showFrame(0);
  }

  function play() {
    if (timer) { pause(); return; }
    if (frameIndex >= frames.length - 1) { frameIndex = 0; }
    setPlayButton(true);
    timer = setInterval(() => {
      if (frameIndex >= frames.length - 1) { pause(); return; }
      showFrame(frameIndex + 1);
    }, speed);
  }

  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
    setPlayButton(false);
  }

  function setPlayButton(playing) {
    const btn = document.getElementById('dsaPlay');
    if (btn) btn.textContent = playing ? 'â¸ Pause' : 'â–¶ Play';
  }

  function reset() {
    pause();
    build();
    showFrame(0);
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    computeLayout();
    if (frames[frameIndex]) draw(frames[frameIndex]);
  }

  function mount(target) {
    canvas = target;
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    mode = 'bfs';
    reset();

    const onMode = (btn) => {
      mode = btn.getAttribute('data-mode');
      document.querySelectorAll('[data-mode]').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', String(isActive));
      });
      const targetGroup = document.getElementById('dsaTargetGroup');
      if (targetGroup) targetGroup.style.display = mode === 'dijkstra' ? '' : 'none';
      reset();
      showToast(mode === 'bfs' ? 'BFS mode: fewest hops.' : 'Dijkstra mode: cheapest weighted path.', 'info', 2200);
    };

    const modeButtons = document.querySelectorAll('[data-mode]');
    const modeHandlers = [];
    modeButtons.forEach((btn) => {
      const handler = () => onMode(btn);
      btn.addEventListener('click', handler);
      modeHandlers.push([btn, handler]);
    });

    document.getElementById('dsaPlay')?.addEventListener('click', play);
    document.getElementById('dsaStep')?.addEventListener('click', () => {
      pause();
      if (frameIndex < frames.length - 1) showFrame(frameIndex + 1);
    });
    document.getElementById('dsaReset')?.addEventListener('click', reset);
    document.getElementById('dsaStart')?.addEventListener('change', reset);
    document.getElementById('dsaTarget')?.addEventListener('change', reset);
    document.getElementById('dsaSpeed')?.addEventListener('change', (e) => {
      speed = Number(e.target.value);
      if (timer) { pause(); play(); }
    });

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    cleanup = () => {
      pause();
      window.removeEventListener('resize', onResize);
      modeHandlers.forEach(([btn, handler]) => btn.removeEventListener('click', handler));
    };
  }

  function destroy() {
    if (cleanup) { try { cleanup(); } catch { /* noop */ } }
    cleanup = null;
    if (timer) clearInterval(timer);
    timer = null;
    canvas = null; ctx = null; frames = []; frameIndex = 0; positions = new Map();
  }

  return { mount, destroy };
})();

/* ============================================================================
 * EVENT BINDING (app shell)
 * ========================================================================== */
function bindApp() {
  /* --- Navigation --- */
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      navigate(el.getAttribute('data-nav'), { resetProfile: true });
    });
  });

  /* --- Mobile drawer --- */
  document.getElementById('menuBtn')?.addEventListener('click', openDrawer);
  document.getElementById('scrim')?.addEventListener('click', closeDrawer);

  /* --- Chrome --- */
  document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  document.getElementById('profileMenuBtn')?.addEventListener('click', () => {
    navigate('profile', { profileId: state.currentUser.id });
  });

  document.getElementById('resetBtn')?.addEventListener('click', async () => {
    if (!confirm('Reset all data to the demo defaults? This cannot be undone.')) return;
    await Api.reset();
    location.reload();
  });

  /* --- Global search --- */
  const globalSearch = document.getElementById('globalSearch');
  if (globalSearch) {
    let debounce = null;
    globalSearch.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const token = ++renderToken;
        if (state.view !== 'search') state.view = 'search';
        render();
        if (token !== renderToken) return;
        const input = document.getElementById('searchInput');
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }, 180);
    });
    globalSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { state.searchQuery = e.target.value; navigate('search', { resetProfile: true }); }
    });
  }

  /* --- In-view search input --- */
  const localSearch = document.getElementById('searchInput');
  if (localSearch) {
    let debounce = null;
    localSearch.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        render();
        const input = document.getElementById('searchInput');
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }, 180);
    });
  }

  /* --- Profile links --- */
  document.querySelectorAll('[data-profile]').forEach((el) => {
    el.addEventListener('click', () => {
      navigate('profile', { profileId: el.getAttribute('data-profile') });
    });
  });

  /* --- Add friend --- */
  document.querySelectorAll('[data-add]').forEach((el) => {
    el.addEventListener('click', () => sendFriendRequest(el.getAttribute('data-add')));
  });

  /* --- Remove friend --- */
  document.querySelectorAll('[data-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-remove');
      if (confirm(`Remove ${getUserName(id)} from your friends?`)) removeFriend(id);
    });
  });

  /* --- Accept / reject --- */
  document.querySelectorAll('[data-accept]').forEach((el) => {
    el.addEventListener('click', () => acceptRequest(Number(el.getAttribute('data-accept'))));
  });
  document.querySelectorAll('[data-reject]').forEach((el) => {
    el.addEventListener('click', () => rejectRequest(Number(el.getAttribute('data-reject'))));
  });

  /* --- Global keyboard shortcuts --- */
  document.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    closeDrawer();
    if (state.view !== 'dashboard' && state.currentUser) {
      navigate('dashboard', { resetProfile: true });
    }
  }
  // "/" focuses search (unless already typing in a field)
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
    const input = document.getElementById('globalSearch') ?? document.getElementById('searchInput');
    if (input) { e.preventDefault(); input.focus(); }
  }
}

/* ============================================================================
 * GLOBAL ERROR GUARDS
 * ========================================================================== */
window.addEventListener('error', (event) => {
  console.error('[Uncaught]', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled promise]', event.reason);
});

/* ============================================================================
 * BOOT
 * ========================================================================== */
window.addEventListener('DOMContentLoaded', initApp);
window.addEventListener('resize', () => {
  clearTimeout(window.__gsnResizeTimer);
  window.__gsnResizeTimer = setTimeout(() => {
    if (state.view === 'network') NetworkView.mount(document.getElementById('networkCanvas'));
  }, 220);
});

// Expose a tiny debug surface (handy in the console).
window.GraphSocial = { state, SocialGraph, RecommendationEngine, Api, Storage };
