import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function conflictingBashExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash",
    label: "Conflicting Bash",
    description: "CONFLICTING_BASH_EXTENSION",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "conflict" }] };
    },
  });
}
