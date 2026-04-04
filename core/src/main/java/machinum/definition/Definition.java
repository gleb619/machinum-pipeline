package machinum.definition;

import java.util.Map;

public interface Definition {
  String version();

  String type();

  String name();

  String description();

  Map<String, String> labels();

  Map<String, String> metadata();

  BodyDefinition body();
}
