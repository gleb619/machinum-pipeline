package machinum.streamer;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointStore;
import machinum.definition.PipelineDefinition.SourceDefinition;

@Slf4j
public final class FileSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;
  private static final Set<String> SUPPORTED_EXTENSIONS = Set.of(".md", ".txt", ".markdown");

  private final SourceDefinition source;
  private final CheckpointStore checkpointStore;
  private final int batchSize;

  public FileSourceStreamer(SourceDefinition source, CheckpointStore checkpointStore) {
    this(source, checkpointStore, DEFAULT_BATCH_SIZE);
  }

  public FileSourceStreamer(SourceDefinition source, CheckpointStore checkpointStore, int batchSize) {
    this.source = source;
    this.checkpointStore = checkpointStore;
    this.batchSize = batchSize;
  }

  @Override
  public StreamResult stream(Path workspaceDir, String runId) {
    StreamCursor initialCursor = loadCursor(runId);
    return new FileStreamResult(workspaceDir, initialCursor);
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

  private class FileStreamResult extends AbstractStreamResult {
    private final Path workspaceDir;
    private final List<Path> files;
    private int nextFileIndex;

    public FileStreamResult(Path workspaceDir, StreamCursor initialCursor) {
      this.workspaceDir = workspaceDir;
      this.cursor.set(initialCursor);
      this.files = new ArrayList<>();
      init();
    }

    private void init() {
      String uri = source.uri().get();
      if (uri == null || uri.isBlank()) {
        log.warn("Source URI is empty, nothing to stream");
        return;
      }

      SourceUriParser.ParsedSourceUri parsed = SourceUriParser.parse(uri);
      Path sourceDir = workspaceDir.resolve(parsed.path());
      String format = parsed.getQueryParam("format", "folder");

      if (!Files.exists(sourceDir)) {
        setError(StreamError.io("Source path not found: " + sourceDir, null, currentCursor()));
        return;
      }

      try {
        files.addAll(collectFiles(sourceDir, format));
        this.nextFileIndex = currentCursor().itemOffset();
      } catch (IOException e) {
        setError(StreamError.io("Failed to list source directory: " + sourceDir, e, currentCursor()));
      }
    }

    @Override
    public Iterator<List<StreamItem>> iterator() {
      return new FileStreamerIterator();
    }

    private class FileStreamerIterator implements Iterator<List<StreamItem>> {

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
                .meta("type", "source")
                .meta("name", fileName)
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
