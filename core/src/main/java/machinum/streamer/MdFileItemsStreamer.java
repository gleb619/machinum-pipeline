package machinum.streamer;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointStore;
import machinum.definition.PipelineDefinition.ItemsDefinition;

@Slf4j
public final class MdFileItemsStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final ItemsDefinition items;
  private final CheckpointStore checkpointStore;
  private final int batchSize;

  public MdFileItemsStreamer(ItemsDefinition items, CheckpointStore checkpointStore) {
    this(items, checkpointStore, DEFAULT_BATCH_SIZE);
  }

  public MdFileItemsStreamer(ItemsDefinition items, CheckpointStore checkpointStore, int batchSize) {
    this.items = items;
    this.checkpointStore = checkpointStore;
    this.batchSize = batchSize;
  }

  @Override
  public StreamResult stream(Path workspaceDir, String runId) {
    StreamCursor initialCursor = loadCursor(runId);
    return new MdFileStreamResult(workspaceDir, initialCursor);
  }

  private StreamCursor loadCursor(String runId) {
    if (runId == null || checkpointStore == null) {
      return StreamCursor.initial();
    }
    try {
      return checkpointStore.load(runId)
          .map(snapshot -> {
            int offset = (int) snapshot.runContext().getOrDefault("itemOffset", 0);
            int windowId = (int) snapshot.runContext().getOrDefault("windowId", 0);
            return new StreamCursor(snapshot.currentStateIndex(), offset, windowId);
          })
          .orElse(StreamCursor.initial());
    } catch (Exception e) {
      log.error("Failed to load checkpoint for runId={}", runId, e);
      return StreamCursor.initial();
    }
  }

  private class MdFileStreamResult extends AbstractStreamResult {
    private final Path workspaceDir;
    private final List<Path> files;
    private int nextFileIndex;

    public MdFileStreamResult(Path workspaceDir, StreamCursor initialCursor) {
      this.workspaceDir = workspaceDir;
      this.cursor.set(initialCursor);
      this.files = new ArrayList<>();
      init();
    }

    private void init() {
      String path = items.path().get();
      if (path == null || path.isBlank()) {
        log.warn("Items path is empty, nothing to stream");
        return;
      }

      Path itemsDir = workspaceDir.resolve(path);
      if (!Files.exists(itemsDir)) {
        setError(StreamError.io("Items path not found: " + itemsDir, null, currentCursor()));
        return;
      }

      try {
        files.addAll(collectMarkdownFiles(itemsDir));
        this.nextFileIndex = currentCursor().itemOffset();
      } catch (IOException e) {
        setError(StreamError.io("Failed to list items directory: " + itemsDir, e, currentCursor()));
      }
    }

    @Override
    public Iterator<List<StreamItem>> iterator() {
      return new MdStreamerIterator();
    }

    private class MdStreamerIterator implements Iterator<List<StreamItem>> {

      @Override
      public boolean hasNext() {
        return nextFileIndex < files.size() && error.get() == null;
      }

      @Override
      public List<StreamItem> next() {
        List<StreamItem> batch = new ArrayList<>();
        for (int i = 0; i < batchSize && nextFileIndex < files.size(); i++) {
          Path file = files.get(nextFileIndex);
          try {
            String content = Files.readString(file);
            String fileName = file.getFileName().toString();

            StreamItem item = StreamItem.builder()
                .file(Optional.ofNullable(file))
                .index(nextFileIndex)
                .content(content)
                .meta("type", items.type().get().name())
                .meta("name", fileName)
                .meta("format", "md")
                .build();
            batch.add(item);
            nextFileIndex++;
          } catch (IOException e) {
            setError(StreamError.io("Failed to read: " + file, e, currentCursor()));
            break;
          }
        }
        if (!batch.isEmpty()) {
          updateCursor(currentCursor().advance(batch.size()));
        }
        return List.copyOf(batch);
      }
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
