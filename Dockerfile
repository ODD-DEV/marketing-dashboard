FROM python:3.11-slim
WORKDIR /app
COPY slack_order_notify.py erp_config.json ./
CMD ["python", "-u", "slack_order_notify.py"]
