import type { DTO } from "~/api/client";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";

export function GenericConnection({
  spec,
  config,
  onChange,
}: {
  spec: DTO["SetupProviderTypeDTO"];
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <>
      {spec.fields?.map((field) => (
        <section key={field.key} className="flex flex-col gap-2">
          <Label required={field.required}>{field.label}</Label>
          <TextInput
            value={config[field.key] ?? ""}
            onChange={(v) => onChange({ ...config, [field.key]: v })}
            type={field.kind === "secret" ? "password" : "text"}
            placeholder={field.placeholder}
          />
          {field.help && <HelpText>{field.help}</HelpText>}
        </section>
      ))}
    </>
  );
}
