package machinum.streamer;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointStore;
import machinum.definition.PipelineDefinition.SourceDefinition;
import machinum.http.HttpStreamer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Slf4j
@RequiredArgsConstructor
public final class HttpSourceStreamer implements Streamer {

  private static final long QUEUE_POLL_TIMEOUT_MS = 5000;
  private static final int MAX_IDLE_POLLS = 10;

  private final SourceDefinition source;
  private final ObjectMapper objectMapper;
  private final CheckpointStore checkpointStore;
  // TODO: Handle batch size based on current runner settings
  private final int batchSize;

  @Getter
  private final BlockingQueue<JsonNode> incomingQueue = new LinkedBlockingQueue<>();
  // TODO: Stop server on job done
  private final AtomicReference<Runnable> httpServerShutdown = new AtomicReference<>();

  @Override
  public StreamResult stream(Path workspaceDir, String runId) {
    startHttpServer();
    StreamCursor initialCursor = loadCursor(runId);
    return new HttpStreamResult(initialCursor);
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

  private class HttpStreamResult extends AbstractStreamResult {
    private final int offset;
    private int index;
    private boolean closed = false;

    public HttpStreamResult(StreamCursor initialCursor) {
      this.cursor.set(initialCursor);
      this.offset = initialCursor.itemOffset();
      this.index = 0;
    }

    @Override
    public Iterator<List<StreamItem>> iterator() {
      return new HttpStreamerIterator();
    }

    @Override
    public void close() {
      closed = true;
      stopHttpServer();
    }

    private class HttpStreamerIterator implements Iterator<List<StreamItem>> {

      private List<StreamItem> nextBatch = null;
      private int idleCount = 0;

      @Override
      public boolean hasNext() {
        if (closed || error.get() != null) {
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
        while (batch.size() < batchSize) {
          try {
            JsonNode payload = incomingQueue.poll(QUEUE_POLL_TIMEOUT_MS, TimeUnit.MILLISECONDS);

            if (payload == null) {
              idleCount++;
              if (idleCount >= MAX_IDLE_POLLS) {
                log.info(
                    "HTTP streamer idle timeout ({}ms), ending stream",
                    QUEUE_POLL_TIMEOUT_MS * MAX_IDLE_POLLS);
                return batch.isEmpty() ? null : batch;
              }
              return batch.isEmpty() ? null : batch;
            }

            idleCount = 0;

            if (index < offset) {
              index++;
              continue;
            }

            StreamItem item = parseHttpPayload(payload, index);
            batch.add(item);
            index++;
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.info("HTTP SourceStreamer interrupted");
            closed = true;
            return batch.isEmpty() ? null : batch;
          } catch (Exception e) {
            setError(StreamError.parse("Failed to parse HTTP payload: " + e.getMessage(), e, currentCursor()));
            return batch.isEmpty() ? null : batch;
          }
        }
        return batch;
      }
    }
  }

  private void startHttpServer() {
    if (httpServerShutdown.get() != null) {
      return;
    }

    httpServerShutdown.set(HttpStreamer.start(new String[0], payload -> {
      try {
        incomingQueue.put(payload);
        return HttpStreamer.success();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        log.error("Interrupted while queuing HTTP message", e);
        return HttpStreamer.failed();
      }
    }));

    log.info("HTTP server started");
  }

  private void stopHttpServer() {
    if (httpServerShutdown.get() != null) {
      try {
        httpServerShutdown.get().run();
        log.info("HTTP server stopped");
      } catch (Exception e) {
        log.error("Failed to stop HTTP server", e);
      } finally {
        httpServerShutdown.set(null);
      }
    }
  }

  // TODO: Redo to mapstruct mapper
  private StreamItem parseHttpPayload(JsonNode node, int index) {
    String content = extractTextField(node, "content");
    if (content == null) {
      content = extractTextField(node, "text");
    }

    String id = extractTextField(node, "id");

    StreamItem.StreamItemBuilder builder = StreamItem.builder().index(index).content(content);

    if (id != null) {
      builder.meta("id", id);
    }

    builder.meta("source", "http");

    JsonNode metaNode = node.get("metadata");
    if (metaNode != null && metaNode.isObject()) {
      metaNode
          .properties()
          .forEach(entry -> builder.meta(entry.getKey(), toJsonValue(entry.getValue())));
    }

    node.properties().forEach(entry -> {
      String key = entry.getKey();
      if (!key.equals("content")
          && !key.equals("text")
          && !key.equals("id")
          && !key.equals("metadata")) {
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
    if (node.isTextual()) {
      return node.asText();
    }
    if (node.isInt()) {
      return node.asInt();
    }
    if (node.isLong()) {
      return node.asLong();
    }
    if (node.isDouble()) {
      return node.asDouble();
    }
    if (node.isBoolean()) {
      return node.asBoolean();
    }
    if (node.isArray() || node.isObject()) {
      return node.toString();
    }
    return null;
  }
}
