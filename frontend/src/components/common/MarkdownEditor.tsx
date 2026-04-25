import { type ComponentType, type CSSProperties, lazy, Suspense } from "react";

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  placeholder?: string;
  className?: string;
  lineNumbers?: boolean;
  foldGutter?: boolean;
  highlightActiveLine?: boolean;
  highlightActiveLineGutter?: boolean;
  lineWrapping?: boolean;
}

// Bundling CodeMirror + the markdown lang + the docket theme behind a single
// React.lazy boundary keeps the heavy chunk (~600 kB) off the main bundle.
// Every editor surface uses this wrapper.
const LazyEditor: ComponentType<MarkdownEditorProps> = lazy(async () => {
  const [{ default: CodeMirror }, { markdown }, { EditorView }, themeMod] = await Promise.all([
    import("@uiw/react-codemirror"),
    import("@codemirror/lang-markdown"),
    import("@codemirror/view"),
    import("~/lib/cmTheme"),
  ]);
  const themeExtensions = themeMod.docketCodeMirrorTheme();

  function Editor({
    value,
    onChange,
    height,
    placeholder,
    className,
    lineNumbers = false,
    foldGutter = false,
    highlightActiveLine = false,
    highlightActiveLineGutter = false,
    lineWrapping = false,
  }: MarkdownEditorProps) {
    const extensions = lineWrapping
      ? [markdown(), EditorView.lineWrapping, ...themeExtensions]
      : [markdown(), ...themeExtensions];
    return (
      <CodeMirror
        value={value}
        height={height}
        theme="none"
        extensions={extensions}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        basicSetup={{
          lineNumbers,
          foldGutter,
          highlightActiveLine,
          highlightActiveLineGutter,
        }}
      />
    );
  }
  return { default: Editor };
});

function EditorSkeleton({ height }: { height?: string }) {
  const style: CSSProperties = height ? { height } : { minHeight: "120px" };
  return (
    <div
      style={style}
      className="flex items-center justify-center bg-surface-alt text-xs text-fg-faint"
    >
      Loading editor…
    </div>
  );
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense fallback={<EditorSkeleton height={props.height} />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
