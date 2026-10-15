// Supplemental reporter for the disposable PostgreSQL suite only. TAP remains
// enabled and Node preserves the original test exit status. No credentials or
// production queries are used by this suite; do not reuse for hosted jobs.
const { inspect } = require('node:util');
const escape = s => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
module.exports = async function* githubTestReporter(events) {
  for await (const event of events) {
    if (process.env.GITHUB_ACTIONS !== 'true' || event.type !== 'test:fail') continue;
    const error = event.data.details?.error;
    if (error?.failureType === 'subtestsFailed') continue; // report actual assertion, not just parent
    const message = `${event.data.name}\n${inspect(error, { depth: 4 })}`.slice(0, 8000);
    yield `::error title=Disposable PostgreSQL test failed::${escape(message)}\n`;
  }
};
