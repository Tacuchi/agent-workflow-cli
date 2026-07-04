import { Box, Text } from "ink";
import { colors, icons } from "../theme.js";
import type { WorkspaceContext } from "./tabs-config.js";

export interface HomeHeaderProps {
  brand: string;
  version: string;
  handle?: string;
  workspaceContext: WorkspaceContext;
}

const DEFAULT_HANDLE = "@tacuchi";
const DOT = "·";

/**
 * Sync colored by state:
 * - "in sync" → ok (green)
 * - "dirty"   → warn (amber)
 * - "N↑ M↓"   → info (blue) — divergence from upstream
 * - fallback  → dim
 */
function syncColor(sync: string): string {
  if (sync === "in sync") return colors.ok;
  if (sync === "dirty") return colors.warn;
  if (/[↑↓]/.test(sync)) return colors.info;
  return colors.dim;
}

function parseBranchLabel(branchLabel: string): { branch: string; sync: string } {
  const idx = branchLabel.indexOf(" · ");
  if (idx < 0) return { branch: branchLabel, sync: "" };
  return { branch: branchLabel.slice(0, idx), sync: branchLabel.slice(idx + 3) };
}

export function HomeHeader({
  brand,
  version,
  handle = DEFAULT_HANDLE,
  workspaceContext,
}: HomeHeaderProps) {
  const { branch, sync } = parseBranchLabel(workspaceContext.branchLabel);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Line 1: brand + version */}
      <Text wrap="truncate-end">
        <Text color={colors.accent} bold>
          {icons.brand}
        </Text>
        <Text color={colors.bright} bold>
          {" "}
          AGENT WORKFLOW
        </Text>
        <Text color={colors.faint}>
          {"  "}v{version}
        </Text>
      </Text>
      {/* Line 2: project · handle · branch · sync · sessions */}
      <Text wrap="truncate-end">
        <Text color={colors.dim}>{brand || "—"}</Text>
        <Text color={colors.faint}>{`  ${DOT}  `}</Text>
        <Text color={colors.dim}>{handle}</Text>
        {branch ? (
          <>
            <Text color={colors.faint}>{`  ${DOT}  `}</Text>
            <Text color={colors.dim}>
              {icons.branch} {branch}
            </Text>
            {sync ? (
              <>
                <Text color={colors.faint}> </Text>
                <Text color={syncColor(sync)}>{sync}</Text>
              </>
            ) : null}
          </>
        ) : null}
        <Text color={colors.faint}>{`  ${DOT}  `}</Text>
        <Text color={colors.dim}>{workspaceContext.sessionsLabel}</Text>
      </Text>
    </Box>
  );
}
