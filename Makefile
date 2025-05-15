.PHONY: help
help: ## 帮助文件
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {sub("\\\\n",sprintf("\n%22c"," "), $$2);printf "\033[36m%-40s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: inspector
inspector:
	npx @modelcontextprotocol/inspector node build/index.js

dist/index.js: ${shell find ./src -name "*.ts"} package.json webpack.config.js
	npm run build

.PHONY: build
build: dist/index.js

.PHONY: dev
dev: build
	node dist/index.js
	
.PHONY: sse
sse: build
	node dist/index.js --mode sse


.PHONY: clean
clean:
	rm -rf dist

.PHONY: deploy
deploy:
	set -a; eval $$(grep -v '^#' .env); set +a; s deploy -y -a ${ACCESS}

.PHONY: publish
publish: clean build
	npm publish --registry https://registry.npmjs.org

serverlessdevs/src/code/index.js: dist/index.js
	cp -r dist/ ./serverlessdevs/src/code/

.PHONY: template
template: serverlessdevs/src/code/index.js
	cd serverlessdevs && s registry publish