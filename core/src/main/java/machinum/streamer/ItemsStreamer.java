package machinum.streamer;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.ItemsDefinition;

/**
 * Streams items from an {@link ItemsDefinition} (chapter, paragraph, line, etc.).
 *
 * <p>Supports observer-style streaming with batch emission, resume via {@link StreamCursor}, and
 * error-tolerant operation.
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
public final class ItemsStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final ItemsDefinition items;
  private final int batchSize;

  public ItemsStreamer(ItemsDefinition items) {
    this(items, DEFAULT_BATCH_SIZE);
  }

  public ItemsStreamer(ItemsDefinition items, int batchSize) {
    this.items = items;
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

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial("items-stream");
    int offset = cur.itemOffset();

    String path = items.path() != null ? items.path().get() : null;
    if (path == null || path.isBlank()) {
      log.warn("Items path is empty, nothing to stream");
      return;
    }

    Path itemsDir = workspaceDir.resolve(path);
    if (!Files.exists(itemsDir)) {
      errorHandler.accept(StreamError.io("Items path not found: " + itemsDir, null, cur));
      return;
    }

    try {
      List<Path> files = collectFiles(itemsDir);
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
              .file(file)
              .index(index)
              .content(content)
              .meta("type", items.type() != null ? items.type().get().name() : "chapter")
              .meta("name", fileName)
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
      errorHandler.accept(StreamError.io("Failed to list items directory: " + itemsDir, e, cur));
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
