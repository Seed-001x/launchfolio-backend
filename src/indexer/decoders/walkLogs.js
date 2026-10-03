// src/indexer/decoders/walkLogs.js — correlate Anchor `Program data:` events
// with the instruction (top-level or inner) that emitted them.
//
// Log structure (Solana runtime):
//   `Program <pid> invoke [1]`            top-level instruction start
//   `Program <pid> invoke [2]`            inner (CPI) instruction start
//   `Program log: ...`                    plain log, ignored
//   `Program data: <base64>`              Anchor event payload — belongs to
//                                         the innermost open invoke frame
//   `Program <pid> success` / `failed`    frame close
//
// Correlation: the Nth `invoke [1]` for program P is the Nth top-level
// compiled instruction whose programId is P. Inner frames inherit the
// top-level instruction index and get a per-instruction inner sequence
// number. This is required: real Pump trades frequently arrive via routers
// (GMGN, Photon, ...), where the Pump instruction is inner, and `migrate`
// transactions emit migration + pool-creation events from inner frames.

const INVOKE_RE = /^Program (\S+) invoke \[(\d+)\]$/;
const DATA_RE = /^Program data: (\S+)$/;
const END_RE = /^Program (\S+) (success|failed)$/;

/**
 * Get the full ordered account-key list for a transaction, handling both
 * legacy and v0 (address lookup tables) messages.
 */
export function getAllAccountKeys(tx) {
  const msg = tx.transaction.message;
  const staticKeys = msg.accountKeys || [];
  const loaded = tx.meta?.loadedAddresses || {};
  return [
    ...staticKeys,
    ...(loaded.writable || []),
    ...(loaded.readonly || []),
  ];
}

/**
 * List of top-level instructions: [{ index, programId }].
 * Works on the compiled message form returned by getTransaction (encoding json).
 */
export function getTopLevelInstructions(tx) {
  const keys = getAllAccountKeys(tx);
  const ixs = tx.transaction.message.instructions || [];
  return ixs.map((ix, index) => ({
    index,
    programId: keys[ix.programIdIndex],
    accounts: ix.accounts || [],
    data: ix.data || null,
  }));
}

/**
 * Walk logs and call onEvent({ programId, dataBase64, instructionIndex,
 * innerInstructionIndex, logLineIndex }) for every `Program data:` line that
 * appears inside a known program's invoke frame.
 *
 * @param {string[]} logs - tx.meta.logMessages
 * @param {Object} tx - full transaction JSON (for instruction correlation)
 * @param {Set<string>} programIds - programs whose data events we want
 */
export function walkProgramDataEvents(logs, tx, programIds) {
  const topLevel = getTopLevelInstructions(tx);
  // Per-program cursor: which top-level instruction index is the next invoke[1].
  const cursorByProgram = new Map();
  const stack = []; // frames: { programId, depth, instructionIndex, innerSeq }
  const events = [];

  const nextTopLevelIndex = (programId) => {
    const used = cursorByProgram.get(programId) || 0;
    let seen = 0;
    for (const ix of topLevel) {
      if (ix.programId !== programId) continue;
      if (seen === used) {
        cursorByProgram.set(programId, used + 1);
        return ix.index;
      }
      seen++;
    }
    return null; // invoke without a matching compiled ix (should not happen)
  };

  logs.forEach((line, logLineIndex) => {
    let m = INVOKE_RE.exec(line);
    if (m) {
      const [, programId, depthStr] = m;
      const depth = Number(depthStr);
      if (depth === 1) {
        const instructionIndex = nextTopLevelIndex(programId);
        stack.push({ programId, depth, instructionIndex, innerSeq: 0 });
      } else {
        // Inner instruction: inherit the innermost frame's top-level index.
        const parent = stack[stack.length - 1];
        const instructionIndex = parent ? parent.instructionIndex : null;
        const innerInstructionIndex = parent ? ++parent.innerSeq : 0;
        stack.push({ programId, depth, instructionIndex, innerInstructionIndex });
      }
      return;
    }

    m = DATA_RE.exec(line);
    if (m && stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (programIds.has(frame.programId)) {
        events.push({
          programId: frame.programId,
          dataBase64: m[1],
          instructionIndex: frame.instructionIndex,
          innerInstructionIndex: frame.innerInstructionIndex ?? 0,
          logLineIndex,
          depth: frame.depth,
        });
      }
      return;
    }

    m = END_RE.exec(line);
    if (m) {
      // Pop the matching frame; tolerate imbalance (defensive).
      const [, programId] = m;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].programId === programId) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  });

  return events;
}

/**
 * Decode a base64 `Program data:` payload: [8-byte discriminator | Borsh].
 * Returns { name, discriminator, fields } or null when the discriminator is
 * not in the map (unknown event — skipped, NOT a failure).
 */
export function matchEvent(dataBase64, discriminatorMap) {
  const raw = Buffer.from(dataBase64, 'base64');
  if (raw.length < 8) return null;
  const disc = [...raw.subarray(0, 8)];
  for (const [name, expected] of Object.entries(discriminatorMap)) {
    if (disc.length === expected.length && disc.every((b, i) => b === expected[i])) {
      return { name, discriminator: disc, payload: raw.subarray(8) };
    }
  }
  return null;
}
