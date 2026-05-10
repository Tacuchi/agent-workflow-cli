import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { InputLockProvider, useInputLock } from "../../src/cli/tui/input-lock.js";

const Q = "q";
const ENTER = "\r";

function GlobalSpy({ onKey }: { onKey: (input: string) => void }) {
  const { locked } = useInputLock();
  useInput(
    (input) => {
      onKey(input);
    },
    { isActive: !locked },
  );
  return <Text>spy active={String(!locked)}</Text>;
}

function Locker({ lock: shouldLock }: { lock: boolean }) {
  const { lock, unlock } = useInputLock();
  useEffect(() => {
    if (shouldLock) lock();
    else unlock();
  }, [shouldLock, lock, unlock]);
  return null;
}

describe("InputLock", () => {
  it("locked=false: el global handler recibe la tecla q", async () => {
    const onKey = vi.fn();
    const { stdin, unmount } = render(
      <InputLockProvider>
        <Locker lock={false} />
        <GlobalSpy onKey={onKey} />
      </InputLockProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(Q);
    await new Promise((r) => setTimeout(r, 50));
    expect(onKey).toHaveBeenCalledWith(Q);
    unmount();
  });

  it("locked=true: el global handler NO recibe la tecla q", async () => {
    const onKey = vi.fn();
    const { stdin, unmount } = render(
      <InputLockProvider>
        <Locker lock={true} />
        <GlobalSpy onKey={onKey} />
      </InputLockProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(Q);
    await new Promise((r) => setTimeout(r, 50));
    expect(onKey).not.toHaveBeenCalled();
    unmount();
  });

  it("ENTER define la constante para uso en otros tests", () => {
    expect(ENTER).toBe("\r");
  });
});
