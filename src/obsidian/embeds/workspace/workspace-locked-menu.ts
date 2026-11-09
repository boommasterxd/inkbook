import type { ObsidianEmbedActions } from "../../commands";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { createOwnedMenuFactory } from "../../menus/owned-menu-factory";
import { LockedEmbedMenu } from "../presentation/locked-embed-menu";
import type {
  PresentationAttachment,
  PresentationSessionPort,
} from "../presentation/presentation-port";
import type { WorkspaceFeedbackHost } from "./workspace-feedback-router";
import type { WorkspaceEmbedActionFeedbackPort } from "./workspace-embed-actions";
import { deleteWorkspaceEmbed, openWorkspaceEmbedSvg } from "./workspace-embed-actions";
import type { WorkspaceRefreshProfiles } from "./workspace-refresh-profiles";

export function bindWorkspaceLockedMenu(
  profiles: Pick<WorkspaceRefreshProfiles, "workScheduler">,
  actions: ObsidianEmbedActions,
  host: WorkspaceFeedbackHost,
): NonNullable<PresentationSessionPort["mountLockedMenu"]> {
  return (attachment, activate) =>
    createWorkspaceLockedMenu({
      attachment,
      activate,
      actions,
      host,
      scheduler: profiles.workScheduler(attachment.root.ownerDocument.defaultView),
      feedback: { show: (code) => host.manager.showInPresentation(attachment.root, { code }) },
    });
}

function createWorkspaceLockedMenu(options: {
  readonly attachment: PresentationAttachment;
  readonly activate: () => void;
  readonly actions: ObsidianEmbedActions;
  readonly host: WorkspaceFeedbackHost;
  readonly scheduler: WorkScheduler;
  readonly feedback: WorkspaceEmbedActionFeedbackPort;
}): LockedEmbedMenu | undefined {
  const { attachment, host } = options;
  const preview = attachment.preview;
  if (preview === undefined) return undefined;
  const isCurrent = () =>
    attachment.root.isConnected && attachment.root.dataset.inkbookState === "locked";
  return new LockedEmbedMenu({
    localization: host.localization,
    root: attachment.root,
    preview,
    factory: createOwnedMenuFactory({
      anchor: preview,
      workScheduler: options.scheduler,
      ...(host.keymap === undefined ? {} : { keymap: host.keymap }),
      ...(host.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: host.createPhoneSheetHost }),
    }),
    onEdit: options.activate,
    onOpenSvg: () => {
      if (isCurrent())
        void openWorkspaceEmbedSvg(options.actions, attachment.embedReference, options.feedback);
    },
    onDeleteEmbed: () => {
      if (!isCurrent()) return;
      void deleteWorkspaceEmbed({
        actions: options.actions,
        feedback: options.feedback,
        isCurrent,
        reference: attachment.embedReference,
        ...(attachment.removal === undefined ? {} : { removal: attachment.removal }),
      });
    },
  });
}
