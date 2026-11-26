// Turns the single-file build into page content for a claude.ai artifact (which supplies its own <html>/<head>/<body>).
import { readFileSync, writeFileSync } from 'node:fs';
const [src = 'dist-single/index.html', out = 'dist-single/artifact.html'] = process.argv.slice(2);
const html = readFileSync(src, 'utf8');
const title = /<title>[\s\S]*?<\/title>/.exec(html.split('<script')[0])?.[0] ?? '<title>Wedding Seating Planner</title>';
// pull scripts out first: the bundle itself contains <style>/<title> text inside strings
const scripts = [];
const rest = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (m) => (scripts.push(m), ''));
const fonts = [...rest.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)[^>]*>/g)].map((m) => m[0]);
const styles = [...rest.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
const page = [title, '<meta name="color-scheme" content="light dark">', ...fonts, ...styles, '<div id="root"></div>', ...scripts].join('\n');
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB, ${scripts.length} script, ${styles.length} style)`);
