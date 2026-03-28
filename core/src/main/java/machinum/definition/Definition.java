package machinum.definition;

import java.util.Map;

public interface Definition {
  String version();

  String type();

  String name();

  String description();

  Map<String, Object> labels();

  Map<String, Object> metadata();

  BodyDefinition body();
}
