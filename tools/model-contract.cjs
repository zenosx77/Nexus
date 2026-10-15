// Execute the actual browser canonicalizer/validator, not a second implementation.
// Node 22 is required by both the repository and the scheduled trainer.
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('function sbCanonicalStr('), html.indexOf('function sbUtf8('));
const context = vm.createContext({});
vm.runInContext(source, context, { timeout: 1000 });
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.argv.includes('--validate')) context.sbValidateArtifact(input);
process.stdout.write(context.sbCanonical(input));
