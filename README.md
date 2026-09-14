# Graph Social

### A visual social-network demo built with graph algorithms

Graph Social is a frontend-only web app that turns a small social network into an interactive graph. Every person is a node, every friendship is an edge, and suggestions are ranked using real graph-analysis logic.

The app includes demo login accounts, friend requests, recommendations, graph analytics, an interactive canvas network, and an algorithm lab for BFS and Dijkstra.

---

## Features

### Animated auth screen

- Full-screen canvas particle background through `#canvas3d`
- Animated login card with mouse tilt/parallax
- Mini network canvas in the login showcase panel
- Demo account shortcuts
- Local account registration

### Dashboard

- Current friend count
- Pending request count
- Network reach
- Recommended people
- Recent graph activity

### Friend suggestions

Suggestions are ranked using:

- Adamic-Adar similarity
- Jaccard similarity
- Graph proximity
- Network popularity

Each recommendation includes an explanation such as mutual friends, hop distance, and connection strength.

### Interactive network

The network view supports:

- Dragging nodes
- Panning the canvas
- Zooming with the mouse wheel
- Hovering nodes for relationship context
- Clicking a node to open a profile
- Re-layout and fit controls

### Algorithm lab

The DSA lab visualizes:

- **BFS**, for the fewest friendship hops
- **Dijkstra**, for the strongest weighted path

You can play, pause, reset, or step through the traversal frame by frame.

### Local persistence

The project uses `localStorage` for demo data, accounts, requests, friendships, theme preference, and the current session. If browser storage is unavailable, it falls back to in-memory storage for the current page session.

---

## Demo Access

Use any of these demo accounts:

| Username | Email | Password |
| --- | --- | --- |
| `faizan` | `faizan@demo.com` | `demo123` |
| `kaushik` | `kaushik@demo.com` | `demo123` |
| `arya` | `arya@demo.com` | `demo123` |
| `animesh` | `animesh@demo.com` | `demo123` |

You can sign in with either the username or email.

---

## Run Locally

No build tool or dependency installation is required.

Open `index.html` directly in your browser, or serve the folder with a small static server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

---

## Project Structure

```text
social_network_website/
|-- index.html    # HTML shell, app mount point, and background canvas
|-- styles.css    # Design tokens, auth UI, app shell, cards, graph, and responsive styles
|-- script.js     # Data, graph logic, rendering, auth binding, canvas controllers, and app events
|-- README.md     # Project documentation
```

---

## Main JavaScript Modules

- `Storage` handles versioned local persistence.
- `SocialGraph` manages users, edges, BFS, Dijkstra, and analytics.
- `MinHeap` powers Dijkstra's priority queue.
- `RecommendationEngine` ranks people you may know.
- `Api` acts as an async data boundary for future backend integration.
- `AuthEffects` manages the login particle background, mini network canvas, and card tilt.
- `NetworkView` renders the interactive force-directed graph.
- `DsaLab` animates BFS and Dijkstra.

---

## Recent Sync Fixes

The app was updated so the login screen and script boot order are synchronized:

- Login DOM events now bind inside `bindLogin()` after `renderLogin()` creates the elements.
- The canvas background and auth animations mount through `AuthEffects`.
- Auth animation cleanup runs before switching views.
- Register view now uses the same auth wrapper and is visible immediately.
- Auth-only CSS is scoped so it does not override dashboard buttons and forms.
- The signed-in app can scroll normally, while auth screens remain full-screen.

Validation performed:

```bash
node --check script.js
```

---

## Graph Logic

Friendships are stored as an undirected adjacency list. A friendship is saved once but works in both directions.

The weighted edge cost is:

```text
edge cost = 1 + 2 / (1 + number of mutual friends)
```

More mutual friends make a connection cheaper, so Dijkstra can prefer stronger multi-hop routes over weaker direct paths.

---

## Backend Path

The frontend already has an `Api` layer, so the local persistence can later be replaced with REST endpoints without rewriting the UI.

Possible next steps:

- REST API integration
- Secure authentication
- MySQL or PostgreSQL persistence
- Real-time notifications
- Larger network datasets
- Community detection
- Recommendation evaluation metrics

---

## Note

This is a portfolio/demo frontend. Authentication is local to the browser and is not production security.
