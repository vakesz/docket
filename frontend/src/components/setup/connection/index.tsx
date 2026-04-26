export { AzureConnection } from "./AzureConnection";
export { Combobox } from "./Combobox";
export { GenericConnection } from "./GenericConnection";
export { GithubConnection } from "./GithubConnection";

import type { DTO } from "~/api/client";
import { AzureConnection } from "./AzureConnection";
import { GenericConnection } from "./GenericConnection";
import { GithubConnection } from "./GithubConnection";

export function ConnectionFields({
  spec,
  config,
  onChange,
  cli,
}: {
  spec: DTO["SetupProviderTypeDTO"];
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  cli: DTO["CliStatusDTO"] | null;
}) {
  if (spec.id === "github") {
    return <GithubConnection config={config} onChange={onChange} cli={cli} />;
  }
  if (spec.id === "azure_devops") {
    return <AzureConnection config={config} onChange={onChange} cli={cli} />;
  }
  return <GenericConnection spec={spec} config={config} onChange={onChange} />;
}
