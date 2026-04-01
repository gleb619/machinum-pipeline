package machinum.tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@NoArgsConstructor(access = AccessLevel.PRIVATE)
public final class HmacVerifier {

  private static final String ALGORITHM = "HmacSHA256";
  private static final String SECRET_ENV = "MACHINUM_TOOL_SECRET";

  public static String generateSignature(Path jarPath) throws IOException {
    byte[] secret = getSecret();
    byte[] fileContent = Files.readAllBytes(jarPath);

    try {
      Mac mac = Mac.getInstance(ALGORITHM);
      SecretKeySpec keySpec = new SecretKeySpec(secret, ALGORITHM);
      mac.init(keySpec);

      byte[] hmac = mac.doFinal(fileContent);
      return HexFormat.of().formatHex(hmac);
    } catch (NoSuchAlgorithmException | InvalidKeyException e) {
      throw new RuntimeException("Failed to generate HMAC signature", e);
    }
  }

  public static boolean verifySignature(Path jarPath, String expectedSignature) throws IOException {
    String actualSignature = generateSignature(jarPath);
    boolean matches = actualSignature.equals(expectedSignature);

    if (!matches) {
      log.warn("Signature verification failed for JAR: {}", jarPath);
    }

    return matches;
  }

  private static byte[] getSecret() {
    String secret = System.getenv(SECRET_ENV);
    if (secret == null || secret.isBlank()) {
      secret = "machinum-default-secret-change-in-production";
      log.debug("Using default HMAC secret (set {} for production)", SECRET_ENV);
    }
    return secret.getBytes();
  }
}
