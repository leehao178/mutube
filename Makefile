YOUTUBE_IPA := ./ipa/YouTube_4.54.01_decrypted.ipa
OUTPUT_IPA := ./mutube.ipa
PATCHER_FLAGS :=

ifneq ($(PRINTF_LOGS),)
ifneq ($(PRINTF_LOGS),0)
PATCHER_FLAGS += --enable-printf-logs
endif
endif

.PHONY: all
all: $(OUTPUT_IPA)

$(OUTPUT_IPA): $(YOUTUBE_IPA) patcher.py inject.js
	uv run patcher.py --in $(YOUTUBE_IPA) --out $(OUTPUT_IPA) $(PATCHER_FLAGS)

# Recover the original decrypted IPA from a previously built MuTube IPA:
#   make restore RESTORE_IN=/path/to/old-mutube.ipa
# Writes $(YOUTUBE_IPA), refusing to overwrite an existing one.
RESTORE_IN ?=

.PHONY: restore
restore:
	@test -n "$(RESTORE_IN)" || { echo "usage: make restore RESTORE_IN=/path/to/mutube.ipa"; exit 1; }
	uv run unpatch.py --in $(RESTORE_IN) --out $(YOUTUBE_IPA)

.PHONY: clean
clean:
	rm -f $(OUTPUT_IPA)
