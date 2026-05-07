# Checkpoint

CHECKPOINT.md is the single artifact that lets a fresh conversation resume work without re-exploring the codebase. It is written before `/compact` (PreCompact hook) or at session end (SessionEnd hook), and read on resume.

## checkpoint-read

Read `CHECKPOINT.md` of the active (or specified) session.

```bash
agent-workflow checkpoint-read
agent-workflow checkpoint-read --code session035
```

Returns the raw markdown payload plus parsed metadata (phase, last-updated, refs).

## checkpoint-write

Write a CHECKPOINT.md draft for the active (or specified) session. Includes the canonical sections (Lo último que hice / Próximo paso / Decisiones recientes / Archivos tocados / Contexto crítico / Refs).

```bash
agent-workflow checkpoint-write
agent-workflow checkpoint-write --code session035
agent-workflow checkpoint-write --force          # overwrite even if recent
```

Flags: `--code <sessionNNN>`, `--force`.

The output is intentionally a *draft*: the AI typically fills in the placeholder sections (`_[AI: ...]_`) with the real content before the file is committed.

## compress-checkpoint

Identify long artifacts that should be compressed before checkpoint generation (HALLAZGOS.md, EVIDENCIA.md, DISCOVERY.md, etc.). Returns a list of files exceeding the threshold so you can summarize them in place.

```bash
agent-workflow compress-checkpoint --code session035
agent-workflow compress-checkpoint --code session035 --threshold 12000   # bytes
```

Flags: `--code <sessionNNN>`, `--threshold <bytes>` (default ~10000).

## resume-summary

Compact resume payload for the PostCompact hook. Returns the minimal information needed to greet the user with "Resumen — sesión activa: ..." right after `/compact`.

```bash
agent-workflow resume-summary
```

No flags. Reads the active session and its CHECKPOINT.md (if present).

## auto-compact-on-close

SessionEnd hook target. Walks every active session and writes a checkpoint for each.

```bash
agent-workflow auto-compact-on-close
```

You should rarely call this manually; it is wired into the host harness via the SessionEnd hook configured by the plugin's installer.
