package machinum.streamer;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@NoArgsConstructor(access = AccessLevel.PRIVATE)
public final class SourceUriParser {

  public static ParsedSourceUri parse(String uri) {
    if (uri == null || uri.isBlank()) {
      throw new IllegalArgumentException("Source URI cannot be null or empty");
    }

    try {
      String normalizedUri = uri;
      if (uri.startsWith("file://") && !uri.startsWith("file:///")) {
        normalizedUri = "file://" + uri.substring(7);
      }

      URI parsed = new URI(normalizedUri);
      String scheme = parsed.getScheme();
      if (scheme == null) {
        throw new IllegalArgumentException("Source URI must have a schema: " + uri);
      }

      SourceType type =
          switch (scheme.toLowerCase()) {
            case "file" -> SourceType.FILE;
            case "http", "https" -> SourceType.HTTP;
            case "script" -> SourceType.SCRIPT;
            case "samples" -> SourceType.SAMPLES;
            case "void" -> SourceType.VOID;
            default ->
              throw new IllegalArgumentException(
                  ("Unsupported source URI schema: '%s' in URI: %s. Supported schemas: file://, http://, https://, script://, samples://, void://")
                      .formatted(scheme, uri));
          };

      String path;
      if (scheme.equalsIgnoreCase("file")) {
        String ssp = normalizedUri.substring(7);
        if (ssp.contains("?")) {
          ssp = ssp.split("\\?")[0];
        }
        path = ssp.startsWith("/") ? ssp.substring(1) : ssp;
        if (ssp.startsWith("/") && ssp.length() > 1 && Character.isLetter(ssp.charAt(1))) {
          path = ssp.substring(1);
        }
      } else if (scheme.equalsIgnoreCase("script")) {
        path = normalizedUri.substring(9);
        if (path.contains("?")) {
          path = path.split("\\?")[0];
        }
      } else if (scheme.equalsIgnoreCase("void")) {
        path = "";
      } else {
        path = normalizedUri.split("\\?")[0];
      }

      Map<String, String> queryParams = parseQueryParams(parsed.getQuery());

      return new ParsedSourceUri(type, path, queryParams, normalizedUri);

    } catch (URISyntaxException e) {
      throw new IllegalArgumentException("Invalid source URI: " + uri, e);
    }
  }

  private static Map<String, String> parseQueryParams(String query) {
    if (query == null || query.isEmpty()) {
      return Collections.emptyMap();
    }

    Map<String, String> params = new HashMap<>();
    String[] pairs = query.split("&");
    for (String pair : pairs) {
      String[] keyValue = pair.split("=", 2);
      if (keyValue.length == 2) {
        params.put(keyValue[0], keyValue[1]);
      } else if (keyValue.length == 1) {
        params.put(keyValue[0], "");
      }
    }
    return Collections.unmodifiableMap(params);
  }

  public record ParsedSourceUri(
      SourceType type, String path, Map<String, String> queryParams, String originalUri) {

    public String getQueryParam(String name) {
      return queryParams.getOrDefault(name, null);
    }

    public String getQueryParam(String name, String defaultValue) {
      return queryParams.getOrDefault(name, defaultValue);
    }
  }

  public enum SourceType {
    FILE,
    HTTP,
    SCRIPT,
    SAMPLES,
    VOID
  }
}
