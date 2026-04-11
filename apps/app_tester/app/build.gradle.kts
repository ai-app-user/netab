plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val netabVersionCode = providers.gradleProperty("netabVersionCode").orNull?.toIntOrNull() ?: 1
val netabVersionName = providers.gradleProperty("netabVersionName").orNull ?: "0.1.0"

android {
    namespace = "cc.ispot.netab.apptester"
    compileSdk = 35

    defaultConfig {
        applicationId = "cc.ispot.netab.apptester"
        minSdk = 26
        targetSdk = 35
        versionCode = netabVersionCode
        versionName = netabVersionName
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
