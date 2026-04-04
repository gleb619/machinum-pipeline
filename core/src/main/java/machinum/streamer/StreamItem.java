package machinum.streamer;

import java.nio.file.Path;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record StreamItem(
    Path file,
    Integer index,
    Integer subIndex,
    String content,
    @Singular("meta") Map<String, Object> metadata) {

  public static StreamItem of(Path file, int index, String content) {
    return StreamItem.builder().file(file).index(index).content(content).build();
  }

  public Object metaOrDefault(String key, Object defaultValue) {
    return metadata.getOrDefault(key, defaultValue);
  }

  public Object meta(String key) {
    return metadata.get(key);
  }
}
