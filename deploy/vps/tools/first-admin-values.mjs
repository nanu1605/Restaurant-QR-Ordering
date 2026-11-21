/**
 * The values file of the first platform admin's tool (first-admin.mjs, beside this one): two lines
 * that set its FIRST_ADMIN_EMAIL and FIRST_ADMIN_NAME, put in front of the tool on its stdin on the
 * server, so that the email and the name are on no command line there (sudo's journal keeps one up
 * to 187 days), in no shell's history and in no process list. The owner runs it on their own
 * machine with Node 24 (Windows with Git Bash or PowerShell, or any other system), its output piped
 * straight to the server:
 *
 *   node deploy/vps/tools/first-admin-values.mjs |
 *     ssh ops@<the tunnel's SSH host> 'umask 077 && cat > ~/incoming/first-admin.values.mjs'
 *
 * It asks for the email and the name on stderr, reads the answers from the terminal and checks them
 * as first-admin.mjs does, in its words, then writes these two lines to stdout and nothing else:
 *
 *   process.env.FIRST_ADMIN_EMAIL = "owner@example.com";
 *   process.env.FIRST_ADMIN_NAME = "Owner name";
 *
 * Each value is a JSON string with every character outside printable ASCII written as a \uXXXX
 * escape, so the lines are plain ASCII and pass any shell's pipe unchanged: Windows PowerShell 5.1
 * re-encodes what it pipes from one program to the next. It refuses a terminal for its output,
 * which is meant for the pipe (Git Bash's mintty gives Node a pipe for its terminal, so there it
 * can't tell). Exits 0 with the lines, 2 when it refused and wrote nothing, 1 when the lines could
 * not be written. Only a run of this file asks anything: importing it, as the tests and pnpm
 * vps:rehearse do, gives the maker and the checks alone. docs/RUNBOOK.md, "The first platform admin
 * (production)"; docs/DECISIONS.md VPS-134.
 */

// The Team page's email rule (inviteSchema in src/features/platform/team.ts), as first-admin.mjs
// has it: trimmed, lowercased, then zod's email pattern.
const EMAIL =
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/** Refused before anything was written: exit 2. */
export class Refused extends Error {}
/** The lines could not be written: exit 1. */
class Failed extends Error {}

/** Each UTF-16 unit of `text` as a \uXXXX escape. */
const escaped = (text) =>
  text
    .split('')
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');

/**
 * A value the owner gave, quoted as first-admin.mjs quotes it: its control and format characters
 * and its line and paragraph separators written out as escapes.
 */
const shown = (value) =>
  JSON.stringify(String(value).slice(0, 200)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escaped);

/**
 * The email as first-admin.mjs takes it, or refused in its words.
 * @param {string} value
 * @returns {string}
 */
export function checkEmail(value) {
  const email = String(value).trim().toLowerCase();
  if (!EMAIL.test(email)) {
    throw new Refused(`FIRST_ADMIN_EMAIL ${shown(value)} is not an email address`);
  }
  return email;
}

/**
 * The name as first-admin.mjs takes it, or refused in its words.
 * @param {string} value
 * @returns {string}
 */
export function checkName(value) {
  const name = String(value).trim();
  // The Team page's 1 to 80, and nothing a terminal would act on where the tool prints it.
  if (name.length < 1 || name.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Refused(
      `FIRST_ADMIN_NAME ${shown(value)} must be 1 to 80 characters, without control or format characters`,
    );
  }
  return name;
}

/** `text` as a JSON string in plain ASCII: every unit outside printable ASCII as a \uXXXX escape. */
const literal = (text) => JSON.stringify(text).replace(/[^\x20-\x7e]/g, escaped);

/**
 * The values file: the email's line, then the name's, each value checked first and as the tool
 * takes it, with a newline at the end and nothing else.
 * @param {string} email
 * @param {string} name
 * @returns {string}
 */
export function valuesFile(email, name) {
  return [
    `process.env.FIRST_ADMIN_EMAIL = ${literal(checkEmail(email))};`,
    `process.env.FIRST_ADMIN_NAME = ${literal(checkName(name))};`,
    '',
  ].join('\n');
}

/**
 * The lines of `input` as they come, each without its \n or \r\n: the terminal's own line editing
 * and echo, where Node's readline would end a line at U+2028 or U+2029 too and cut a name short.
 */
async function* linesOf(input) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of input) {
    rest += decoder.decode(chunk, { stream: true });
    for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
      yield rest.slice(0, end).replace(/\r$/, '');
      rest = rest.slice(end + 1);
    }
  }
  rest += decoder.decode();
  if (rest) yield rest.replace(/\r$/, '');
}

/** `text` on `stream`, once the system has taken it. */
const written = (stream, text) =>
  new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });

/** Asks for the two values, then writes their file. */
async function main() {
  if (process.stdout.isTTY) {
    throw new Refused(
      'stdout is a terminal: pipe it to the server as docs/RUNBOOK.md says (The first platform admin (production))',
    );
  }
  // A line that comes before its question (pasted, or piped in) waits for it.
  const lines = linesOf(process.stdin);
  const ask = async (question) => {
    process.stderr.write(question);
    const line = await lines.next();
    return line.done ? undefined : line.value;
  };
  const email = await ask("The first platform admin's email: ");
  if (email === undefined) {
    throw new Refused('no FIRST_ADMIN_EMAIL: the input ended before it');
  }
  checkEmail(email);
  const name = await ask('Their name, 1 to 80 characters: ');
  if (name === undefined) {
    throw new Refused('no FIRST_ADMIN_NAME: the input ended before it');
  }
  // One write, once both are checked: after a refusal the file on the server is empty.
  const file = valuesFile(email, name);
  try {
    await written(process.stdout, file);
  } catch (error) {
    throw new Failed(`could not write the lines (${error?.code ?? error?.message ?? error})`);
  }
}

if (import.meta.main) {
  let code = 0;
  try {
    await main();
  } catch (error) {
    const known = error instanceof Refused || error instanceof Failed;
    code = error instanceof Refused ? 2 : 1;
    await written(
      process.stderr,
      `first-admin-values: ${code === 2 ? 'refused' : 'failed'}: ${known ? error.message : (error?.message ?? error)}\n`,
    ).catch(() => {});
  }
  // exit() once each line is out, stdin left as it is: at an ordinary end Node closes stdin, and on
  // a Windows console libuv ends the read it left waiting there by writing an Enter into the
  // console's input, which ssh, waiting for its passphrase in the same console, could take.
  process.exit(code);
}
