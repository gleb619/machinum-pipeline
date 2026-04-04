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

@Slf4j
public final class MdFileItemsStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final ItemsDefinition items;
  private final int batchSize;

  public MdFileItemsStreamer(ItemsDefinition items) {
    this(items, DEFAULT_BATCH_SIZE);
  }

  public MdFileItemsStreamer(ItemsDefinition items, int batchSize) {
    this.items = items;
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

    String path = items.path().get();
    if (path == null || path.isBlank()) {
      log.warn("Items path is empty, nothing to stream");
      callback.onStreamStart(cur);
      callback.onStreamEnd(cur);
      return;
    }

    Path itemsDir = workspaceDir.resolve(path);
    if (!Files.exists(itemsDir)) {
      errorHandler.accept(StreamError.io("Items path not found: " + itemsDir, null, cur));
      callback.onStreamStart(cur);
      callback.onStreamEnd(cur);
      return;
    }

    callback.onStreamStart(cur);

    try {
      List<Path> files = collectMarkdownFiles(itemsDir);
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
              .meta("type", items.type().get().name())
              .meta("name", fileName)
              .meta("format", "md")
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
      errorHandler.accept(StreamError.io("Failed to list items directory: " + itemsDir, e, cur));
      callback.onStreamEnd(cur);
    }
  }

  private List<Path> collectMarkdownFiles(Path dir) throws IOException {
    List<Path> files = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
      for (Path entry : stream) {
        if (Files.isRegularFile(entry)) {
          String name = entry.getFileName().toString().toLowerCase();
          if (name.endsWith(".md") || name.endsWith(".markdown")) {
            files.add(entry);
          }
        }
      }
    }
    files.sort(Path::compareTo);
    return files;
  }
}
