from conans import ConanFile, CMake


class McapTestConan(ConanFile):
    settings = "os", "compiler", "build_type", "arch"
    generators = "cmake"
    requires = "catch2/2.13.8", "mcap/0.0.1", "nlohmann_json/3.10.5"

    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()
