export SCRIPT_DIR=$(realpath $(dirname $0))

replace() {
    export org=$2 new=$3
    find $1 -type f -exec sed -i 's@'$org'@'$new'@g' {} \;
}

set_keys() {
    mkdir -p $SCRIPT_DIR/keys
    # If secrets provided, use them; otherwise generate a temporary debug keystore
    if [ -n "$LOCAL_TEST_JKS" ] && [ -n "$STORE_TEST_JKS" ]; then
        echo $LOCAL_TEST_JKS | base64 -d > $SCRIPT_DIR/keys/local.properties
        echo $STORE_TEST_JKS | base64 -d > $SCRIPT_DIR/keys/test.jks
    else
        echo "No secrets provided, generating debug keystore..."
        mkdir -p $SCRIPT_DIR/keys
        cat > $SCRIPT_DIR/keys/local.properties <<EOF
storePassword=123456
keyPassword=123456
keyAlias=debug
EOF
        # Generate debug keystore if keytool available
        if command -v keytool >/dev/null 2>&1; then
            keytool -genkeypair -keystore $SCRIPT_DIR/keys/test.jks -storepass 123456 -keypass 123456 -alias debug -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Spotify No Ads, OU=Test, O=Test, C=US" -noprompt 2>/dev/null || echo "keytool gen failed"
        else
            # Fallback: try via JDK in chromium if exists
            echo "keytool not found, will try later"
        fi
    fi
    unset LOCAL_TEST_JKS
    unset STORE_TEST_JKS
}

sign_apk() {
    export apksigner=$(find $ANDROID_HOME/build-tools -name apksigner | sort | tail -n 1)
    source $SCRIPT_DIR/keys/local.properties
    $apksigner sign -verbose -ks $SCRIPT_DIR/keys/test.jks --ks-pass pass:$storePassword --key-pass pass:$keyPassword --ks-key-alias $keyAlias --out $2 $1 || return 1
}

sign_aab() {
    source $SCRIPT_DIR/keys/local.properties
    jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore $SCRIPT_DIR/keys/test.jks -storepass $storePassword -keypass $keyPassword -signedjar $2 $1 $keyAlias || return 1
}

version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
}
