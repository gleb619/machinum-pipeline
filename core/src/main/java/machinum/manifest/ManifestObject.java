package machinum.manifest;

import java.nio.file.Path;

public record ManifestObject(Path filepath, Type type) {

  public enum Type {
    root,
    tools,
    pipeline,
    unknown,
  }
}
