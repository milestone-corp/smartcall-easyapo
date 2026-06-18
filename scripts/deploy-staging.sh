#!/bin/bash
#
# scripts/deploy-staging.sh
#
# Staging環境（RPA03）専用デプロイスクリプト
#
# 使い方:
#   ./scripts/deploy-staging.sh            # Staging (RPA03 192.168.20.72:3011) にデプロイ
#   ./scripts/deploy-staging.sh --dry-run  # 実行内容だけ表示
#   SKIP_GIT_SYNC=1 ./scripts/deploy-staging.sh
#
# 本番店舗デプロイは scripts/deploy.sh <店舗ID> を使用すること
#
# 本番 deploy.sh との違い:
#   - envs/staging.env を固定で使用
#   - Staging は1院しか居ないため --remove-orphans を使い、
#     旧 docker-compose.staging.yml で起動した同名コンテナを自動クリーンアップする
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_PATH="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="/tmp"

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
    esac
done

# ===== envs/staging.env を読み込み =====
ENV_FILE="$LOCAL_PATH/envs/staging.env"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}エラー: $ENV_FILE が見つかりません${NC}"
    echo "envs/_template.env をコピーして作成してください"
    exit 1
fi

cp "$ENV_FILE" "$LOCAL_PATH/.env"
set -a; . "$LOCAL_PATH/.env"; set +a

for var in SHOP_NAME SHOP_PORT DEPLOY_HOST DEPLOY_USER DEPLOY_BASTION_HOST DEPLOY_BASTION_USER DEPLOY_SSH_KEY; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}エラー: $var が $ENV_FILE で未設定です${NC}"
        exit 1
    fi
done

SSH_KEY="${DEPLOY_SSH_KEY/#\~/$HOME}"
TARBALL_NAME="smartcall-easyapo-staging.tar.gz"
REMOTE_PATH="/home/${DEPLOY_USER}/smartcall-easyapo"
CONTAINER="${CONTAINER_NAME:-smartcall-easyapo-${SHOP_NAME}}"
COMPOSE_PROJECT="smartcall-easyapo-${SHOP_NAME}"

# ===== バナー =====
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}EasyApo RPA Staging デプロイ${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "env file:     ${ENV_FILE}"
echo -e "デプロイ先:   ${DEPLOY_USER}@${DEPLOY_HOST}:${SHOP_PORT}"
echo -e "コンテナ名:   ${CONTAINER}"
echo -e "composeproj:  ${COMPOSE_PROJECT}"
echo -e "踏み台:       ${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}"
echo -e "SSH鍵:        ${SSH_KEY}"

if [ "$DRY_RUN" = "1" ]; then
    echo -e "\n${YELLOW}--dry-run なので実際のデプロイは行いません${NC}"
    exit 0
fi

# ===== 1. ローカル状態確認 =====
echo -e "\n${YELLOW}[1/6] ローカルリポジトリの確認${NC}"
cd "$LOCAL_PATH"
if [ -d ".git" ]; then
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo -e "${YELLOW}警告: コミットされていない変更があります${NC}"
        git status --short
        read -p "続行しますか？ (y/N): " confirm
        [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && { echo "キャンセルしました"; exit 0; }
    fi
    CURRENT_COMMIT=$(git log -1 --format='%h %s' 2>/dev/null || echo "N/A")
    echo -e "現在のコミット: ${GREEN}${CURRENT_COMMIT}${NC}"
else
    CURRENT_COMMIT="N/A"
fi

# ===== 2. GitHub同期確認 =====
echo -e "\n${YELLOW}[2/6] GitHubとの同期確認${NC}"
if [ "${SKIP_GIT_SYNC:-0}" = "1" ]; then
    echo -e "${YELLOW}SKIP_GIT_SYNC=1 のためスキップ${NC}"
elif [ -d ".git" ]; then
    git fetch origin 2>/dev/null || true
    LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null || echo "")
    REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null || echo "")
    if [ -n "$LOCAL_HASH" ] && [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
        echo -e "${YELLOW}ローカルとリモート(main)に差分があります${NC}"
        read -p "続行しますか？ (y/N): " confirm
        [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && { echo "キャンセルしました"; exit 0; }
    else
        echo -e "${GREEN}main と一致${NC}"
    fi
fi

# ===== 3. tarball 作成 =====
echo -e "\n${YELLOW}[3/6] ソースコードをtarballに圧縮${NC}"
tar -czf "$TEMP_DIR/$TARBALL_NAME" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='screenshots/*' \
    --exclude='input/*' \
    --exclude='output/*' \
    --exclude='envs' \
    --exclude='.playwright-mcp' \
    --exclude='.claude' \
    --exclude='.DS_Store' \
    .
echo -e "作成完了: $TEMP_DIR/$TARBALL_NAME"
ls -lh "$TEMP_DIR/$TARBALL_NAME"

# ===== 4. 踏み台へ転送 =====
echo -e "\n${YELLOW}[4/6] 踏み台サーバに転送${NC}"
scp -i "$SSH_KEY" "$TEMP_DIR/$TARBALL_NAME" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}:${TEMP_DIR}/"
echo -e "${GREEN}踏み台への転送完了${NC}"

# ===== 5. RPAサーバ転送・展開 =====
echo -e "\n${YELLOW}[5/6] RPAサーバ (${DEPLOY_HOST}) に転送・展開${NC}"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'mkdir -p ${REMOTE_PATH}'"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "scp -i ~/.ssh/milestone ${TEMP_DIR}/${TARBALL_NAME} ${DEPLOY_USER}@${DEPLOY_HOST}:${TEMP_DIR}/"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'cd ${REMOTE_PATH} && tar -xzf ${TEMP_DIR}/${TARBALL_NAME}'"
echo -e "${GREEN}tarball展開完了${NC}"

# ===== 6. docker compose build & up =====
# Staging は1院のみなので --remove-orphans で旧 staging コンテナを自動クリーンアップ
echo -e "\n${YELLOW}[6/6] Dockerイメージビルド・コンテナ起動${NC}"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'cd ${REMOTE_PATH} && sudo COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT} docker compose -f docker-compose.shop.yml build && sudo COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT} docker compose -f docker-compose.shop.yml up -d --remove-orphans'"

echo -e "\nコンテナ状態:"
sleep 3
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'sudo docker ps --filter name=${CONTAINER} --format \"table {{.Names}}\t{{.Status}}\t{{.Ports}}\"'"

echo -e "\n${YELLOW}ヘルスチェック実行${NC}"
sleep 5
HEALTH_RESULT=$(ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'curl -s http://localhost:${SHOP_PORT}/health'" 2>/dev/null || echo "failed")
if echo "$HEALTH_RESULT" | grep -q '"status"'; then
    echo -e "${GREEN}ヘルスチェック OK${NC}"
    echo "$HEALTH_RESULT" | (jq . 2>/dev/null || cat)
else
    echo -e "${RED}ヘルスチェック NG${NC}"
    echo "$HEALTH_RESULT"
fi

# クリーンアップ
echo -e "\n${YELLOW}一時ファイルのクリーンアップ${NC}"
rm -f "$TEMP_DIR/$TARBALL_NAME"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" "rm -f ${TEMP_DIR}/${TARBALL_NAME}" || true
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'rm -f ${TEMP_DIR}/${TARBALL_NAME}'" || true

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}Staging デプロイ完了${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "コミット:     ${CURRENT_COMMIT}"
echo -e "URL:          http://${DEPLOY_HOST}:${SHOP_PORT}"
echo ""
echo -e "ログ確認:"
echo -e "  ssh -i ${SSH_KEY} ${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST} \"ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'sudo docker logs --tail 50 -f ${CONTAINER}'\""
