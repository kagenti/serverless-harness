// Plain-HTTP echo target for RC1-2 (Hop 2). Reflects the received Authorization header so the
// live smoke can prove AB2 injected the real egress credential (and that a denied request never
// reached this far). Adapted from the known-good spike echo (binds :8080 instead of :80, non-root).
const http = require('http');
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const auth = req.headers['authorization'] || null;
    console.log('ECHO-RECV', req.method, req.url, 'auth=' + (auth || '(none)'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, path: req.url, authorization: auth }));
  });
}).listen(8080, () => console.log('echo listening :8080'));
