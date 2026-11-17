// Where the catalog API lives.
// - Running locally with `node server.js`: leave empty (same server).
// - Hosted on GitHub Pages: the page calls the Node server on Render.
//   Change this URL if your Render service has a different name.
window.PATHFINDER_API = location.hostname.endsWith('github.io')
  ? 'https://um-pathfinder.onrender.com'
  : '';
