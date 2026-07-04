/**
 * Oz adapter. Oz is a cloud agent orchestrator with no local workspace config
 * file (MCP config is passed by the host itself via `oz agent run --mcp`, not
 * written by this CLI). Attach/detach are intentionally no-ops.
 */
export interface OzAttachNoop {
  skipped: true;
  reason: "oz_cloud_no_local_config";
}

export function attachOz(_paths: string[], _scopeDir: string): OzAttachNoop {
  return { skipped: true, reason: "oz_cloud_no_local_config" };
}

export function detachOz(_paths: string[], _scopeDir: string): OzAttachNoop {
  return { skipped: true, reason: "oz_cloud_no_local_config" };
}
