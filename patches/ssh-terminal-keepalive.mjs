/**
 * Staging-time patch for @linxin666/dsh-ssh: the SSH terminal session
 * survives UI unmounts (panel tab switches, center-column rebuilds).
 *
 * Client-only: on unmount the WebSocket and the xterm instance move into a
 * module-level slot (render detached, socket open, output flowing into the
 * live buffer); the next mount re-adopts them (reparent the xterm element,
 * rewire status handlers, refit). The disconnect button or a remote exit
 * closes the session. The host needs no change.
 *
 * Applied by stage-dsh.mjs to the installed package's lib/client.js. Anchors
 * are exact strings from the upstream build and throw when they stop
 * matching. Remove this file and its call site once upstream persists
 * sessions itself.
 */
import fs from 'node:fs'
import path from 'node:path'

const MARKER = '/* dsh-desktop ssh-terminal-keepalive */'

/** Replace exactly one occurrence, or throw with the anchor's name. */
function replaceOnce(source, anchorName, from, to) {
  const first = source.indexOf(from)
  if (first === -1) throw new Error(`ssh keepalive patch: anchor "${anchorName}" not found; upstream layout changed. Re-derive the patch.`)
  if (source.indexOf(from, first + 1) !== -1) throw new Error(`ssh keepalive patch: anchor "${anchorName}" is not unique. Re-derive the patch.`)
  return source.slice(0, first) + to + source.slice(first + from.length)
}

export function applySshKeepalivePatch(stagingDir) {
  const file = path.join(stagingDir, 'node_modules', '@linxin666', 'dsh-ssh', 'lib', 'client.js')
  if (!fs.existsSync(file)) return false // minimal flavor / plugin absent
  let s = fs.readFileSync(file, 'utf8')
  if (s.includes(MARKER)) return true // already patched

  // 1. Module-level parking slot, next to the module-level CSS guard.
  s = replaceOnce(s, 'module slot',
    '\t\tlet xtermCssInjected = false;',
    `\t\tlet xtermCssInjected = false;
\t\t${MARKER}
\t\t/** Live session parked across component unmounts; adopted on next mount. */
\t\tlet keptSession = null;`)

  // 2. Track the connected alias; the select's alias state can drift.
  s = replaceOnce(s, 'ref block',
    '\t\t\tconst dataSubRef = (0, react.useRef)(null);',
    `\t\t\tconst dataSubRef = (0, react.useRef)(null);
\t\t\tconst connAliasRef = (0, react.useRef)("");`)

  // 3. Unmount parks a live session; mount adopts a parked one. Replaces the
  //    teardown-on-unmount effect.
  s = replaceOnce(s, 'unmount effect',
    `\t\t\t(0, react.useEffect)(() => () => {
\t\t\t\tteardown();
\t\t\t}, []);`,
    `\t\t\t(0, react.useEffect)(() => () => {
\t\t\t\tconst connection = connRef.current;
\t\t\t\tconst term = termRef.current;
\t\t\t\tif (connection !== null && term !== null && term.element) {
\t\t\t\t\t// Park the live session: detach the render, keep the socket.
\t\t\t\t\tif (keptSession !== null) {
\t\t\t\t\t\ttry { keptSession.dataSub?.dispose(); } catch {}
\t\t\t\t\t\ttry { keptSession.term.dispose(); } catch {}
\t\t\t\t\t\ttry { keptSession.conn.close(); } catch {}
\t\t\t\t\t}
\t\t\t\t\tconst kept = { term, fit: fitRef.current, conn: connection, dataSub: dataSubRef.current, alias: connAliasRef.current, exited: false, detail: void 0 };
\t\t\t\t\tconnection.onReady = void 0;
\t\t\t\t\tconnection.onExit = (code, error) => {
\t\t\t\t\t\tkept.exited = true;
\t\t\t\t\t\tkept.detail = error;
\t\t\t\t\t\ttry { term.options.disableStdin = true; } catch {}
\t\t\t\t\t};
\t\t\t\t\ttry { term.element.remove(); } catch {}
\t\t\t\t\tkeptSession = kept;
\t\t\t\t\tconnRef.current = null;
\t\t\t\t\ttermRef.current = null;
\t\t\t\t\tfitRef.current = null;
\t\t\t\t\tdataSubRef.current = null;
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tteardown();
\t\t\t}, []);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst kept = keptSession;
\t\t\t\tif (kept === null) return;
\t\t\t\tkeptSession = null;
\t\t\t\tconst container = containerRef.current;
\t\t\t\tif (container === null || !kept.term.element) {
\t\t\t\t\ttry { kept.dataSub?.dispose(); } catch {}
\t\t\t\t\ttry { kept.term.dispose(); } catch {}
\t\t\t\t\ttry { kept.conn.close(); } catch {}
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tcontainer.appendChild(kept.term.element);
\t\t\t\ttermRef.current = kept.term;
\t\t\t\tfitRef.current = kept.fit;
\t\t\t\tdataSubRef.current = kept.dataSub;
\t\t\t\tconnAliasRef.current = kept.alias;
\t\t\t\tif (kept.alias !== "") setAlias(kept.alias);
\t\t\t\tif (kept.exited) {
\t\t\t\t\tconnRef.current = null;
\t\t\t\t\tsetStatus({ kind: "exited", alias: kept.alias, detail: kept.detail });
\t\t\t\t} else {
\t\t\t\t\tconnRef.current = kept.conn;
\t\t\t\t\tkept.conn.onExit = (code, error) => {
\t\t\t\t\t\ttry { dataSubRef.current?.dispose(); } catch {}
\t\t\t\t\t\tdataSubRef.current = null;
\t\t\t\t\t\ttry { kept.term.options.disableStdin = true; } catch {}
\t\t\t\t\t\tconnRef.current = null;
\t\t\t\t\t\tsetStatus({ kind: "exited", alias: kept.alias, detail: error });
\t\t\t\t\t};
\t\t\t\t\tsetStatus({ kind: "connected", alias: kept.alias });
\t\t\t\t}
\t\t\t\ttry {
\t\t\t\t\tkept.fit?.fit();
\t\t\t\t\tif (!kept.exited) kept.conn.resize(kept.term.cols, kept.term.rows);
\t\t\t\t\tkept.term.refresh(0, kept.term.rows - 1);
\t\t\t\t} catch {}
\t\t\t}, []);`)

  // 4. Remember the alias a connection was opened for.
  s = replaceOnce(s, 'connect alias capture',
    '\t\t\t\tconnRef.current = connection;',
    `\t\t\t\tconnRef.current = connection;
\t\t\t\tconnAliasRef.current = target;`)

  fs.writeFileSync(file, s)
  return true
}
