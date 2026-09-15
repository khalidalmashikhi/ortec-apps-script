#!/usr/bin/env node
/**
 * Local preview of the web app: assembles Index.html (resolving <?!= include() ?>), injects a
 * google.script.run shim that POSTs to /api, and executes the real server code in the simulator.
 *   node tools/dev-server.js [port]
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const sim = require('./gas-sim');
const G = sim.load();
G.setupSystem();
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function assemble() {
  let html = read('Index.html');
  html = html.replace(/<\?!= include\('([A-Za-z]+)'\) \?>/g, (m, n) => read(n + '.html'));
  html = html.replace(/<\?= appNameAr \?>/g, G.WC.APP_NAME_AR).replace(/<\?= appName \?>/g, G.WC.APP_NAME);
  const shim = `<script>
  window.google = window.google || {};
  google.script = { run: null };
  (function(){
    function make(ok, fail){ return new Proxy({}, { get: function(_, name){
      if (name === 'withSuccessHandler') return function(f){ return make(f, fail); };
      if (name === 'withFailureHandler') return function(f){ return make(ok, f); };
      return function(){ var args = Array.prototype.slice.call(arguments);
        fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, args: args }) })
          .then(function(r){ return r.json(); }).then(function(j){ if (j.__error) { if (fail) fail(new Error(j.__error)); } else if (ok) ok(j.result); })
          .catch(function(e){ if (fail) fail(e); }); };
    } }); }
    google.script.run = make(null, null);
  })();
  </script>`;
  return html.replace('<script src="https://www.gstatic.com/charts/loader.js"></script>', shim + '\n<script src="https://www.gstatic.com/charts/loader.js"></script>');
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try {
        const { name, args } = JSON.parse(body);
        if (!/^api_/.test(name) || typeof G[name] !== 'function') throw new Error('unknown function ' + name);
        out = { result: G[name].apply(null, args) };
      } catch (e) { out = { __error: e.message }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.url === '/__state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ mails: G.__sim.STATE.mails.length, triggers: G.__sim.STATE.triggers.length, sheets: G.__sim.ss.getSheets().map(s => [s.getName(), s.getLastRow()]) })); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(assemble());
});
const port = +(process.argv[2] || 8787);
server.listen(port, () => console.log('Walif Coffee preview on http://localhost:' + port));
