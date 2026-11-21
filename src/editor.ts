import { expandHome } from "./settings.ts";
import type {
  DestinationSettings,
  DoorwaySettings,
  RemoteHostSettings,
} from "./settings.ts";

export type EditorPlan = {
  readonly place: string;
  readonly args: readonly string[];
  readonly requiredFolders: readonly string[];
};

export function remoteAuthority(
  remoteHost: RemoteHostSettings,
  destination: DestinationSettings,
): string {
  const attach = JSON.stringify({
    containerName: `/${destination.container}`,
    settings: { host: remoteHost.dockerEndpoint },
  });
  return `attached-container%2B${Buffer.from(attach).toString("hex")}@ssh-remote%2B${remoteHost.sshAlias}`;
}

export function editorArguments(
  settings: DoorwaySettings,
  remoteHost: RemoteHostSettings,
  destination: DestinationSettings,
  home: string,
  place?: string,
): EditorPlan {
  const authority = remoteAuthority(remoteHost, destination);
  const userDataFolder = expandHome(settings.editor.userDataFolder, home);
  const extensionsFolder = expandHome(settings.editor.extensionsFolder, home);
  const chosenPlace = place ?? destination.folder;
  const openArgs = chosenPlace.endsWith(".code-workspace")
    ? ["--file-uri", `vscode-remote://${authority}${chosenPlace}`]
    : [
        "--folder-uri",
        `vscode-remote://${authority}${chosenPlace}`,
        ...(place === undefined && destination.guide !== undefined
          ? ["--file-uri", `vscode-remote://${authority}${destination.guide}`]
          : []),
      ];
  return {
    place: chosenPlace,
    args: [
      "--user-data-dir",
      userDataFolder,
      "--extensions-dir",
      extensionsFolder,
      "--new-window",
      ...openArgs,
    ],
    requiredFolders: [userDataFolder, extensionsFolder],
  };
}
