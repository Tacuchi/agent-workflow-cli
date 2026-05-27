import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { useListCursor } from "../../src/cli/tui/use-list-cursor.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const tick = () => new Promise((r) => setTimeout(r, 30));

function Harness({ count }: { count: number }) {
  const { cursor, moveUp, moveDown } = useListCursor(count);
  useInput((_i, key) => {
    if (key.downArrow) moveDown();
    if (key.upArrow) moveUp();
  });
  return <Text>cursor={cursor}</Text>;
}

describe("useListCursor", () => {
  it("moves down and clamps at count-1", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await tick();
    expect(lastFrame()).toContain("cursor=0");
    for (let i = 0; i < 5; i++) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain("cursor=2"); // clamp en count-1
  });

  it("moves up and clamps at 0", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(UP);
    await tick();
    expect(lastFrame()).toContain("cursor=0"); // clamp en 0
  });
});
