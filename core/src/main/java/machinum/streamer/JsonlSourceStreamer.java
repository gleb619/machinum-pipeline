package machinum.streamer;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.SourceDefinition;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Slf4j
public final class JsonlSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;

  private final SourceDefinition source;
  private final ObjectMapper objectMapper;
  private final int batchSize;

  public JsonlSourceStreamer(SourceDefinition source, ObjectMapper objectMapper) {
    this(source, objectMapper, DEFAULT_BATCH_SIZE);
  }

  public JsonlSourceStreamer(SourceDefinition source, ObjectMapper objectMapper, int batchSize) {
    this.source = source;
    this.objectMapper = objectMapper;
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
    Path jsonlFile = workspaceDir.resolve(parsed.path());

    if (!Files.exists(jsonlFile)) {
      errorHandler.accept(StreamError.io("JSONL file not found: " + jsonlFile, null, cur));
      callback.onStreamStart(cur);
      callback.onStreamEnd(cur);
      return;
    }

    callback.onStreamStart(cur);

    try (BufferedReader reader = Files.newBufferedReader(jsonlFile)) {
      List<StreamItem> batch = new ArrayList<>();
      int index = 0;
      String line;

      while ((line = reader.readLine()) != null) {
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

          if (batch.size() >= batchSize) {
            cur = cur.advance(batch.size());
            if (!callback.onBatch(List.copyOf(batch), cur)) {
              return;
            }
            batch.clear();
          }
        } catch (Exception e) {
          errorHandler.accept(StreamError.parse(
              "Failed to parse JSONL line " + index + ": " + e.getMessage(), e, cur));
        }
      }

      if (!batch.isEmpty()) {
        cur = cur.advance(batch.size());
        callback.onBatch(List.copyOf(batch), cur);
      }

      callback.onStreamEnd(cur);

    } catch (IOException e) {
      errorHandler.accept(StreamError.io("Failed to read JSONL file: " + jsonlFile, e, cur));
      callback.onStreamEnd(cur);
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
        StreamItem.builder().file(sourceFile).index(index).content(content);

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
