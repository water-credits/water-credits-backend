'use strict';

const mockTransporter = {
  sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-message-id' }),
  verify: jest.fn().mockResolvedValue(true),
};

const nodemailer = {
  createTransport: jest.fn(() => mockTransporter),
};

module.exports = nodemailer;
module.exports.mockTransporter = mockTransporter;
