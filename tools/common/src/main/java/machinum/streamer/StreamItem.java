package machinum.streamer;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import lombok.Builder;
import lombok.Singular;

@Builder
public record StreamItem(
    Optional<Path> file,
    Integer index,
    Integer subIndex,
    String content,
    @Singular("meta") Map<String, Object> data) {

  public static StreamItem of(Optional<Path> file, int index, String content) {
    return StreamItem.builder().file(file).index(index).content(content).build();
  }

  public Object metaOrDefault(String key, Object defaultValue) {
    return data.getOrDefault(key, defaultValue);
  }

  public Object meta(String key) {
    return data.get(key);
  }
}
