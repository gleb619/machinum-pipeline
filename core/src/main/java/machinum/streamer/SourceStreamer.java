package machinum.streamer;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.SourceDefinition;

/**
 * Streams items from a {@link SourceDefinition} (file, http, git, s3).
 *
 * <p>Supports observer-style streaming with batch emission, resume via {@link StreamCursor}, and
 * error-tolerant operation for remote sources.
 *
 * <p>See:
 *
 * <ul>
 *   <li>{@link Streamer} — interface contract
 *   <li><a href="../../../../docs/yaml-schema.md#4x-source-vs-items--data-acquisition-layer">YAML
 *       Schema §4.x</a>
 * </ul>
 */
@Slf4j
public final class SourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final SourceDefinition source;
  private final int batchSize;

  public SourceStreamer(SourceDefinition source) {
    this(source, DEFAULT_BATCH_SIZE);
  }

  public SourceStreamer(SourceDefinition source, int batchSize) {
    this.source = source;
    this.batchSize = batchSize;
  }

  @Override
  @Deprecated(forRemoval = true)
  public List<StreamItem> stream(Path workspaceDir) {
    List<StreamItem> result = new ArrayList<>();
    stream(workspaceDir, null, (items, cursor) -> {
      result.addAll(items);
      return true;
    });
    return result;
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

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial("source-stream");
    int offset = cur.itemOffset();

    String fileLocation = source.fileLocation() != null ? source.fileLocation().get() : null;
    if (fileLocation == null || fileLocation.isBlank()) {
      log.warn("Source fileLocation is empty, nothing to stream");
      return;
    }

    Path sourceDir = workspaceDir.resolve(fileLocation);
    if (!Files.exists(sourceDir)) {
      errorHandler.accept(StreamError.io("Source path not found: " + sourceDir, null, cur));
      return;
    }

    try {
      List<Path> files = collectFiles(sourceDir);
      List<StreamItem> batch = new ArrayList<>();
      int index = 0;

      for (Path file : files) {
        if (index < offset) {
          index++;
          continue;
        }

        try {
          String content = Files.readString(file);
          StreamItem item = StreamItem.builder()
              .file(file)
              .index(index)
              .content(content)
              .meta("format", source.format() != null ? source.format().get().name() : "md")
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
          // continue with next file
        }
      }

      // emit remaining
      if (!batch.isEmpty()) {
        cur = cur.advance(batch.size());
        callback.onBatch(List.copyOf(batch), cur);
      }

    } catch (IOException e) {
      errorHandler.accept(StreamError.io("Failed to list source directory: " + sourceDir, e, cur));
    }
  }

  private List<Path> collectFiles(Path dir) throws IOException {
    List<Path> files = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
      for (Path entry : stream) {
        if (Files.isRegularFile(entry)) {
          files.add(entry);
        }
      }
    }
    files.sort(Path::compareTo);
    return files;
  }
}
