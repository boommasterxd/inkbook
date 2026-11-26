export function guardedRead(path: string, content: string) {
  return {
    content,
    identity: { ctime: 0, mtime: 0, path, size: content.length },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  };
}
