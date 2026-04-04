package machinum.streamer;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
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
  // TODO: Handle batch size based on current runner settings
  private final int batchSize;

  @Getter
  private final BlockingQueue<JsonNode> incomingQueue = new LinkedBlockingQueue<>();
  // TODO: Stop server on job done
  private final AtomicReference<Runnable> httpServerShutdown = new AtomicReference<>();

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

    startHttpServer();

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial();
    int offset = cur.itemOffset();
    int index = 0;
    int idleCount = 0;
    List<StreamItem> batch = new ArrayList<>();

    log.info("HTTP SourceStreamer started, waiting for HTTP messages...");
    callback.onStreamStart(cur);

    try {
      while (true) {
        JsonNode payload = incomingQueue.poll(QUEUE_POLL_TIMEOUT_MS, TimeUnit.MILLISECONDS);

        if (payload == null) {
          idleCount++;
          if (idleCount >= MAX_IDLE_POLLS) {
            log.info(
                "HTTP streamer idle timeout ({}ms), ending stream",
                QUEUE_POLL_TIMEOUT_MS * MAX_IDLE_POLLS);
            if (!batch.isEmpty()) {
              cur = cur.advance(batch.size());
              callback.onBatch(List.copyOf(batch), cur);
              batch.clear();
            }
            callback.onStreamEnd(cur);
            return;
          }

          if (!batch.isEmpty()) {
            cur = cur.advance(batch.size());
            if (!callback.onBatch(List.copyOf(batch), cur)) {
              callback.onStreamEnd(cur);
              return;
            }
            batch.clear();
          }
          continue;
        }

        idleCount = 0;

        if (index < offset) {
          index++;
          continue;
        }

        try {
          StreamItem item = parseHttpPayload(payload, index);
          batch.add(item);
          index++;

          if (batch.size() >= batchSize) {
            cur = cur.advance(batch.size());
            if (!callback.onBatch(List.copyOf(batch), cur)) {
              callback.onStreamEnd(cur);
              return;
            }
            batch.clear();
          }
        } catch (Exception e) {
          errorHandler.accept(
              StreamError.parse("Failed to parse HTTP payload: " + e.getMessage(), e, cur));
        }
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      log.info("HTTP SourceStreamer interrupted");
      if (!batch.isEmpty()) {
        cur = cur.advance(batch.size());
        callback.onBatch(List.copyOf(batch), cur);
      }
      callback.onStreamEnd(cur);
    } finally {
      stopHttpServer();
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
