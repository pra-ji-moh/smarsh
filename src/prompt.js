import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The whole language on one page, as a string.
//
// If a model is going to write Smarsh, something has to tell it how, and that
// something is `docs/for-llms.md`. An embedder should not have to find that file
// on disk, guess where npm put it, or vendor a copy that goes stale:
//
//     import { PROMPT } from 'smarsh';
//     messages.push({ role: 'system', content: PROMPT });
//
// Read from the shipped documentation rather than duplicated here. A second copy
// would drift, and `tests/for-llms.test.mjs` only checks the one in `docs/`.
// The `files` list in package.json includes `docs/`, so it is present in an
// installed package.
//
// It is read once at import. That is a twelve-kilobyte file read, and the
// alternative -- a lazy proxy pretending to be a string -- breaks the moment
// someone concatenates it or asks its `typeof`, which is exactly what an
// embedder does.

const HERE = path.dirname(fileURLToPath(import.meta.url));

function load() {
  try {
    return fs.readFileSync(path.join(HERE, '..', 'docs', 'for-llms.md'), 'utf8');
  } catch {
    // Better an honest short answer than a crash on import. This happens only if
    // the package was installed without its docs, which `files` should prevent.
    return 'The Smarsh reference is missing from this installation. See '
      + 'https://github.com/pra-ji-moh/smarsh/blob/main/docs/for-llms.md';
  }
}

const PROMPT = load();

export default PROMPT;
export { PROMPT };
