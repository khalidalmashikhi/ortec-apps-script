// Extract <script> blocks from HTML files and syntax-check them.
const fs = require('fs'), vm = require('vm'), path = require('path');
let ok = true;
for (const f of fs.readdirSync(__dirname + '/..').filter(x => x.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g; let m, i = 0;
  while ((m = re.exec(src))) { i++; try { new vm.Script(m[1].replace(/<\?!?=[^?]*\?>/g, 'null'), { filename: f + '#script' + i }); } catch (e) { ok = false; console.error(f, e.message); } }
  console.log(f, i, 'script block(s) checked');
}
process.exit(ok ? 0 : 1);
