package machinum.manifest;

import java.util.Map;

public interface Manifest {
  String version();

  String type();

  String name();

  String description();

  Map<String, String> labels();

  Map<String, String> metadata();

  ManifestBody body();
}
