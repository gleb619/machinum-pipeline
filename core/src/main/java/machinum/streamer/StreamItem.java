package machinum.streamer;

import java.nio.file.Path;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

/**
 * Represents a single item flowing through the pipeline stream.
 *
 * <p>Replaces raw {@code Map<String, Object>} to provide type-safe access to item properties. Each
 * item carries its source file, position metadata, content body, and extensible metadata map.
 *
 * <p>See:
 *
 * <ul>
 *   <li>{@link Streamer} — stream producer
 *   <li>{@link StreamCursor} — resume/batch position
 *   <li><a href="../../../../docs/core-architecture.md#1-base-models-mvp">Core Architecture §1</a>
 * </ul>
 */
@Builder
public record StreamItem(
    Path file,
    Integer index,
    Integer subIndex,
    String content,
    @Singular("meta") Map<String, Object> metadata) {

  /** Creates a simple item with file, index, and content. */
  public static StreamItem of(Path file, int index, String content) {
    return StreamItem.builder().file(file).index(index).content(content).build();
  }

  /** Returns metadata value by key, or default if absent. */
  public Object metaOrDefault(String key, Object defaultValue) {
    return metadata.getOrDefault(key, defaultValue);
  }

  /** Returns metadata value by key. */
  public Object meta(String key) {
    return metadata.get(key);
  }
}
