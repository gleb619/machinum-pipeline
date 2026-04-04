package machinum.streamer;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.SourceDefinition;

@Slf4j
public final class FileSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;
  private static final Set<String> SUPPORTED_EXTENSIONS = Set.of(".md", ".txt", ".markdown");

  private final SourceDefinition source;
  private final int batchSize;

  public FileSourceStreamer(SourceDefinition source) {
    this(source, DEFAULT_BATCH_SIZE);
  }

  public FileSourceStreamer(SourceDefinition source, int batchSize) {
    this.source = source;
    this.batchSize = batchSize;
  }

  @Override
  public void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback) {
    stream(
        workspaceDir,
        cursor,
        callback,
        error -> log.error(
            "Stream error at cursor {}: {}",
            error.cursorAtError(),
            error.message(),
            error.cause()));
  }

  @Override
  public void stream(
      Path workspaceDir,
      StreamCursor cursor,
      StreamerCallback callback,
      Consumer<StreamError> errorHandler) {

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial();
    int offset = cur.itemOffset();

    String uri = source.uri().get();
    if (uri == null || uri.isBlank()) {
      log.warn("Source URI is empty, nothing to stream");
      callback.onStreamStart(cur);
      callback.onStreamEnd(cur);
      return;
    }

    SourceUriParser.ParsedSourceUri parsed = SourceUriParser.parse(uri);
    Path sourceDir = workspaceDir.resolve(parsed.path());
    String format = parsed.getQueryParam("format", "folder");

    if (!Files.exists(sourceDir)) {
      errorHandler.accept(StreamError.io("Source path not found: " + sourceDir, null, cur));
      callback.onStreamStart(cur);
      callback.onStreamEnd(cur);
      return;
    }

    callback.onStreamStart(cur);

    try {
      List<Path> files = collectFiles(sourceDir, format);
      List<StreamItem> batch = new ArrayList<>();
      int index = 0;

      for (Path file : files) {
        if (index < offset) {
          index++;
          continue;
        }

        try {
          String content = Files.readString(file);
          String fileName = file.getFileName().toString();

          StreamItem item = StreamItem.builder()
              .file(Optional.ofNullable(file))
              .index(index)
              .content(content)
              .meta("type", "source")
              .meta("name", fileName)
              .meta("format", format)
              .build();
          batch.add(item);
          index++;

          if (batch.size() >= batchSize) {
            cur = cur.advance(batch.size());
            if (!callback.onBatch(List.copyOf(batch), cur)) {
              return;
            }
            batch.clear();
          }
        } catch (IOException e) {
          errorHandler.accept(StreamError.io("Failed to read: " + file, e, cur));
        }
      }

      if (!batch.isEmpty()) {
        cur = cur.advance(batch.size());
        callback.onBatch(List.copyOf(batch), cur);
      }

      callback.onStreamEnd(cur);

    } catch (IOException e) {
      errorHandler.accept(StreamError.io("Failed to list source directory: " + sourceDir, e, cur));
      callback.onStreamEnd(cur);
    }
  }

  private List<Path> collectFiles(Path dir, String format) throws IOException {
    List<Path> files = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
      for (Path entry : stream) {
        if (Files.isRegularFile(entry)) {
          String name = entry.getFileName().toString().toLowerCase();
          boolean supported = isSupportedExtension(name, format);
          if (supported) {
            files.add(entry);
          }
        }
      }
    }
    files.sort(Path::compareTo);
    return files;
  }

  private boolean isSupportedExtension(String fileName, String format) {
    return switch (format) {
      case "md" -> fileName.endsWith(".md") || fileName.endsWith(".markdown");
      case "json" -> fileName.endsWith(".json");
      case "jsonl" -> fileName.endsWith(".jsonl");
      case "pdf" -> fileName.endsWith(".pdf");
      case "docx" -> fileName.endsWith(".docx");
      case "folder", "txt" -> true;
      default -> SUPPORTED_EXTENSIONS.stream().anyMatch(fileName::endsWith);
    };
  }
}
