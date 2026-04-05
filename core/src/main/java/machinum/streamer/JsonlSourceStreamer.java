package machinum.streamer;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointStore;
import machinum.definition.PipelineDefinition.SourceDefinition;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Slf4j
public final class JsonlSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final SourceDefinition source;
  private final ObjectMapper objectMapper;
  private final CheckpointStore checkpointStore;
  private final int batchSize;

  public JsonlSourceStreamer(SourceDefinition source, ObjectMapper objectMapper, CheckpointStore checkpointStore) {
    this(source, objectMapper, checkpointStore, DEFAULT_BATCH_SIZE);
  }

  public JsonlSourceStreamer(SourceDefinition source, ObjectMapper objectMapper, CheckpointStore checkpointStore, int batchSize) {
    this.source = source;
    this.objectMapper = objectMapper;
    this.checkpointStore = checkpointStore;
    this.batchSize = batchSize;
  }

  @Override
  public StreamResult stream(Path workspaceDir, String runId) {
    StreamCursor initialCursor = loadCursor(runId);
    return new JsonlStreamResult(workspaceDir, initialCursor);
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

  private class JsonlStreamResult extends AbstractStreamResult {
    private final Path workspaceDir;
    private final int offset;
    private BufferedReader reader;
    private Path jsonlFile;
    private int index = 0;

    public JsonlStreamResult(Path workspaceDir, StreamCursor initialCursor) {
      this.workspaceDir = workspaceDir;
      this.cursor.set(initialCursor);
      this.offset = initialCursor.itemOffset();
      init();
    }

    private void init() {
      String uri = source.uri().get();
      if (uri == null || uri.isBlank()) {
        log.warn("Source URI is empty, nothing to stream");
        return;
      }

      SourceUriParser.ParsedSourceUri parsed = SourceUriParser.parse(uri);
      this.jsonlFile = workspaceDir.resolve(parsed.path());

      if (!Files.exists(jsonlFile)) {
        setError(StreamError.io("JSONL file not found: " + jsonlFile, null, currentCursor()));
        return;
      }

      try {
        this.reader = Files.newBufferedReader(jsonlFile);
      } catch (IOException e) {
        setError(StreamError.io("Failed to open JSONL file: " + jsonlFile, e, currentCursor()));
      }
    }

    @Override
    public Iterator<List<StreamItem>> iterator() {
      return new JsonlStreamerIterator();
    }

    @Override
    public void close() {
      if (reader != null) {
        try {
          reader.close();
        } catch (IOException e) {
          log.error("Failed to close JSONL reader", e);
        }
      }
    }

    private class JsonlStreamerIterator implements Iterator<List<StreamItem>> {

      private List<StreamItem> nextBatch = null;

      @Override
      public boolean hasNext() {
        if (reader == null || error.get() != null) {
          return false;
        }
        if (nextBatch != null) {
          return true;
        }

        nextBatch = fetchBatch();
        return nextBatch != null;
      }

      @Override
      public List<StreamItem> next() {
        if (!hasNext()) {
          throw new NoSuchElementException();
        }
        List<StreamItem> batch = nextBatch;
        nextBatch = null;
        updateCursor(currentCursor().advance(batch.size()));
        return batch;
      }

      private List<StreamItem> fetchBatch() {
        List<StreamItem> batch = new ArrayList<>();
        try {
          String line;
          while (batch.size() < batchSize && (line = reader.readLine()) != null) {
            if (index < offset) {
              index++;
              continue;
            }
            if (line.isBlank()) {
              index++;
              continue;
            }

            try {
              JsonNode node = objectMapper.readTree(line);
              StreamItem item = parseJsonLine(node, jsonlFile, index);
              batch.add(item);
              index++;
            } catch (Exception e) {
              setError(StreamError.parse("Failed to parse JSONL line " + index, e, currentCursor()));
              break;
            }
          }
        } catch (IOException e) {
          setError(StreamError.io("Failed to read JSONL file", e, currentCursor()));
        }
        return batch.isEmpty() ? null : batch;
      }
    }
  }

  private StreamItem parseJsonLine(JsonNode node, Path sourceFile, int index) {
    String content = extractTextField(node, "content");
    if (content == null) {
      content = extractTextField(node, "text");
    }

    String id = extractTextField(node, "id");
    if (id == null) {
      id = extractTextField(node, "name");
    }

    StreamItem.StreamItemBuilder builder =
        StreamItem.builder().file(Optional.ofNullable(sourceFile)).index(index).content(content);

    if (id != null) {
      builder.meta("id", id);
    }

    node.properties().forEach(entry -> {
      String key = entry.getKey();
      if (!key.equals("content")
          && !key.equals("text")
          && !key.equals("id")
          && !key.equals("name")) {
        builder.meta(key, toJsonValue(entry.getValue()));
      }
    });

    return builder.build();
  }

  private String extractTextField(JsonNode node, String field) {
    JsonNode value = node.get(field);
    if (value != null && value.isTextual()) {
      return value.asText();
    }
    return null;
  }

  private Object toJsonValue(JsonNode node) {
    if (node.isTextual()) return node.asText();
    if (node.isInt()) return node.asInt();
    if (node.isLong()) return node.asLong();
    if (node.isDouble()) return node.asDouble();
    if (node.isBoolean()) return node.asBoolean();
    if (node.isArray() || node.isObject()) return node.toString();
    return null;
  }
}
