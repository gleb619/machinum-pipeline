package machinum.tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.streamer.StreamItem;
import machinum.workspace.WorkspaceLayout;

@Slf4j
public class ChapterWriterTool implements Tool {

  private static final ToolInfo INFO =
      new ToolInfo("writer", "Writes streamed item content to src/main/chapters directory");

  @Override
  public ToolInfo info() {
    return INFO;
  }

  @Override
  public void bootstrap(BootstrapContext context) {
    Path workspaceRoot = context.getWorkspaceRoot();
    WorkspaceLayout layout = new WorkspaceLayout(workspaceRoot);
    Path chaptersDir = layout.getChaptersDir();

    try {
      if (Files.notExists(chaptersDir)) {
        Files.createDirectories(chaptersDir);
        log.info("ChapterWriterTool: Created chapters directory: {}", chaptersDir);
      }
    } catch (IOException e) {
      log.error("ChapterWriterTool: Failed to create chapters directory: {}", chaptersDir, e);
    }
  }

  @Override
  public ToolResult execute(ExecutionContext context) {
    Path workspaceRoot = context.getWorkspaceRoot();
    if (workspaceRoot == null) {
      return ToolResult.failure(context, "workspaceRoot is not set in ExecutionContext");
    }

    StreamItem item = context.getCurrentItem();
    if (item == null || item.content() == null || item.content().isBlank()) {
      log.debug("ChapterWriterTool: No content for item at index {}", context.getCurrentIndex());
      return ToolResult.success(context, Map.of("saved", false, "reason", "empty content"));
    }

    WorkspaceLayout layout = new WorkspaceLayout(workspaceRoot);
    Path chaptersDir = layout.getChaptersDir();

    try {
      if (Files.notExists(chaptersDir)) {
        Files.createDirectories(chaptersDir);
      }

      String fileName = deriveFileName(item, context.getCurrentIndex());
      Path targetPath = chaptersDir.resolve(fileName);

      Files.writeString(targetPath, item.content());

      log.info("ChapterWriterTool: Wrote {} bytes to {}", item.content().length(), targetPath);
      return ToolResult.success(
          context,
          Map.of(
              "saved", true,
              "file", targetPath.toString(),
              "size", item.content().length()));
    } catch (IOException e) {
      log.error("ChapterWriterTool: Failed to write content to {}", chaptersDir, e);
      return ToolResult.failure(context, "Failed to write content: " + e.getMessage());
    }
  }

  private String deriveFileName(StreamItem item, int index) {
    Object fileNameMeta = item.meta("fileName");
    if (fileNameMeta != null) {
      return fileNameMeta.toString();
    }

    if (item.file().isPresent()) {
      return item.file().get().getFileName().toString();
    }

    Object idMeta = item.meta("id");
    if (idMeta != null) {
      String id = idMeta.toString();
      return id.contains(".") ? id : id + ".md";
    }

    return "item-" + index + ".md";
  }
}
