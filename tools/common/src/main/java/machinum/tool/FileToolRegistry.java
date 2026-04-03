package machinum.tool;

import java.nio.file.Path;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public class FileToolRegistry extends AbstractJarToolRegistry {

  public FileToolRegistry(Path toolsDirectory) {
    this.toolsDirectory = toolsDirectory;
  }

  public FileToolRegistry init() {
    loadToolsFromJars();

    return this;
  }

  // TODO: Reuse `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java`
  @Deprecated(forRemoval = true)
  public FileToolRegistry() {
    this(Path.of(".mt/tools"));
  }
}
